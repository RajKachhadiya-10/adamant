use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::AUTHORIZATION;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::api::SseParser;
use crate::config::ModelConfig;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A reasoning model can think for minutes before its next event.
const READ_TIMEOUT: Duration = Duration::from_secs(300);

/// One conversation with the model. Requests are not stored with OpenAI
/// (`store: false`), so every turn resends the history, reasoning included.
pub struct Agent {
    http: reqwest::Client,
    config: ModelConfig,
    instructions: String,
    tools: Value,
    history: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

pub enum Outcome {
    /// The model finished. Calls, if any, must be answered before the next request.
    Done(Vec<Call>),
    Cancelled,
}

impl Agent {
    pub fn new(config: ModelConfig, instructions: String, tools: Value) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .user_agent(concat!("adamant/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "Could not build the model client.".to_string())?;
        Ok(Self {
            http,
            config,
            instructions,
            tools,
            history: Vec::new(),
        })
    }

    pub fn reset(&mut self) {
        self.history.clear();
    }

    pub fn push_user(&mut self, text: &str) {
        self.history.push(json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": text }],
        }));
    }

    pub fn push_output(&mut self, call_id: &str, output: &str) {
        self.history.push(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }));
    }

    /// Streams one response. `on_text` gets each piece of the reply as it arrives.
    pub async fn respond(
        &mut self,
        mut on_text: impl FnMut(&str),
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Outcome, String> {
        let mut body = json!({
            "model": self.config.model,
            "instructions": self.instructions,
            "input": self.history,
            "tools": self.tools,
            "stream": true,
            "store": false,
            // Long sessions drop their oldest turns instead of failing.
            "truncation": "auto",
        });
        if let Some(effort) = &self.config.effort {
            body["reasoning"] = json!({ "effort": effort });
            body["include"] = json!(["reasoning.encrypted_content"]);
        }
        let request = self
            .http
            .post(format!("{}/responses", self.config.base))
            .header(AUTHORIZATION, format!("Bearer {}", self.config.key))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(&body);
        let response = tokio::select! {
            _ = cancel.changed() => return Ok(Outcome::Cancelled),
            response = request.send() => response.map_err(|error| network(&error))?,
        };
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(api_error(status.as_u16(), &text));
        }

        let mut stream = response.bytes_stream();
        let mut parser = SseParser::default();
        loop {
            let chunk = tokio::select! {
                _ = cancel.changed() => return Ok(Outcome::Cancelled),
                chunk = stream.next() => chunk,
            };
            let bytes = match chunk {
                Some(Ok(bytes)) => bytes,
                Some(Err(error)) => return Err(network(&error)),
                None => return Err("The model stream ended before the reply finished.".into()),
            };
            for event in parser.push(&bytes) {
                let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
                    continue;
                };
                match data.get("type").and_then(Value::as_str).unwrap_or("") {
                    "response.output_text.delta" => {
                        if let Some(delta) = data.get("delta").and_then(Value::as_str) {
                            on_text(delta);
                        }
                    }
                    "response.completed" => {
                        let output = data
                            .pointer("/response/output")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        return Ok(Outcome::Done(self.keep(&output)));
                    }
                    "response.incomplete" => {
                        let reason = data
                            .pointer("/response/incomplete_details/reason")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown reason");
                        return Err(format!("The model stopped early ({reason})."));
                    }
                    "response.failed" => {
                        let message = data
                            .pointer("/response/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("The model request failed.");
                        return Err(message.to_string());
                    }
                    "error" => {
                        let message = data
                            .get("message")
                            .or_else(|| data.pointer("/error/message"))
                            .and_then(Value::as_str)
                            .unwrap_or("The model request failed.");
                        return Err(message.to_string());
                    }
                    _ => {}
                }
            }
        }
    }

    /// Appends the reply to the history and returns its tool calls.
    fn keep(&mut self, output: &[Value]) -> Vec<Call> {
        let mut calls = Vec::new();
        for item in output {
            if let Some(kept) = replayable(item) {
                self.history.push(kept);
            }
            if item.get("type").and_then(Value::as_str) == Some("function_call") {
                let field = |name: &str| {
                    item.get(name)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                calls.push(Call {
                    call_id: field("call_id"),
                    name: field("name"),
                    arguments: field("arguments"),
                });
            }
        }
        calls
    }
}

/// The input form of an output item. Ids are dropped: with `store: false` they
/// name nothing the API can look up, and sending one is an error.
fn replayable(item: &Value) -> Option<Value> {
    match item.get("type").and_then(Value::as_str)? {
        "message" => {
            let content: Vec<Value> = item
                .get("content")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(|part| match part.get("type").and_then(Value::as_str)? {
                    "output_text" => Some(json!({
                        "type": "output_text",
                        "text": part.get("text").and_then(Value::as_str).unwrap_or(""),
                    })),
                    "refusal" => Some(json!({
                        "type": "refusal",
                        "refusal": part.get("refusal").and_then(Value::as_str).unwrap_or(""),
                    })),
                    _ => None,
                })
                .collect();
            Some(json!({ "type": "message", "role": "assistant", "content": content }))
        }
        "function_call" => Some(json!({
            "type": "function_call",
            "call_id": item.get("call_id")?,
            "name": item.get("name")?,
            "arguments": item.get("arguments").cloned().unwrap_or_else(|| json!("{}")),
        })),
        // Without the encrypted content a reasoning item cannot be replayed.
        "reasoning" => Some(json!({
            "type": "reasoning",
            "summary": item.get("summary").cloned().unwrap_or_else(|| json!([])),
            "encrypted_content": item.get("encrypted_content")?.as_str()?,
        })),
        _ => None,
    }
}

fn network(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The model did not answer in time.".into()
    } else {
        "Could not reach the model API. Check the network and OPENAI_BASE_URL.".into()
    }
}

fn api_error(status: u16, body: &str) -> String {
    if status == 401 {
        return "The model API rejected OPENAI_API_KEY (401).".into();
    }
    let message = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let hint = if status == 404 {
        " Set ADAMANT_MODEL to a model this key can use."
    } else {
        ""
    };
    match message {
        Some(message) => format!("Model API {status}: {message}{hint}"),
        None => format!("Model API request failed with {status}.{hint}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_output_without_ids() {
        let message = json!({
            "id": "msg_1", "type": "message", "role": "assistant", "status": "completed",
            "content": [{ "type": "output_text", "text": "hi", "annotations": [], "logprobs": [] }],
        });
        assert_eq!(
            replayable(&message).unwrap(),
            json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hi" }] })
        );
        let call = json!({
            "id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "shell",
            "arguments": "{\"command\":\"ls\"}", "status": "completed",
        });
        assert!(replayable(&call).unwrap().get("id").is_none());
        let bare = json!({ "id": "rs_1", "type": "reasoning", "summary": [] });
        assert!(replayable(&bare).is_none());
    }

    #[test]
    fn collects_calls_from_a_reply() {
        let config = ModelConfig {
            key: "k".into(),
            base: "http://localhost".into(),
            model: "m".into(),
            effort: None,
        };
        let mut agent = Agent::new(config, String::new(), json!([])).unwrap();
        agent.push_user("list files");
        let calls = agent.keep(&[json!({
            "type": "function_call", "call_id": "call_1", "name": "shell", "arguments": "{}",
        })]);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "shell");
        assert_eq!(agent.history.len(), 2);
    }
}
