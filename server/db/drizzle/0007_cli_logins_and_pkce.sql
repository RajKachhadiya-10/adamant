CREATE TABLE "cli_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login_id_hash" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"state_hash" text,
	"confirm_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cli_logins_status_check" CHECK ("cli_logins"."status" in ('pending', 'authorized', 'confirmed', 'consumed', 'cancelled')),
	CONSTRAINT "cli_logins_user_check" CHECK ("cli_logins"."status" in ('pending', 'cancelled') or "cli_logins"."user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "code_verifier" text;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD CONSTRAINT "cli_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_logins_login_id_hash_uidx" ON "cli_logins" USING btree ("login_id_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_logins_state_hash_uidx" ON "cli_logins" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_logins_confirm_hash_uidx" ON "cli_logins" USING btree ("confirm_hash");--> statement-breakpoint
CREATE INDEX "cli_logins_expires_at_idx" ON "cli_logins" USING btree ("expires_at");