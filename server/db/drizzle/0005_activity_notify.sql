-- Wakes `GET /activity` the moment a delivery or audit event commits; the API
-- LISTENs on this channel (server/api/services/activityService.ts). NOTIFY is
-- delivered on commit, and one per statement covers a multi-row insert.
CREATE FUNCTION "adamant_notify_activity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('adamant_activity', '');
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_notify_activity" AFTER INSERT ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "adamant_notify_activity"();--> statement-breakpoint
CREATE TRIGGER "webhook_deliveries_notify_activity" AFTER INSERT ON "webhook_deliveries" FOR EACH STATEMENT EXECUTE FUNCTION "adamant_notify_activity"();
