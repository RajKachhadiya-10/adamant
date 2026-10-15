ALTER TABLE "users" ADD COLUMN "auto_merge" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "account_github_id" bigint;