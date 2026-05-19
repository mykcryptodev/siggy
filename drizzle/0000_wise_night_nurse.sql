CREATE TABLE "communities" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"chat_type" text NOT NULL,
	"chat_title" text,
	"admin_user_ids" json DEFAULT '[]'::json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "communities_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "monitored_safes" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"safe_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"label" text,
	"added_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications_sent" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_tx_id" integer NOT NULL,
	"community_id" integer NOT NULL,
	"notification_type" text NOT NULL,
	"telegram_message_id" integer,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"safe_tx_hash" text NOT NULL,
	"nonce" integer,
	"status" text NOT NULL,
	"tx_type" text,
	"to_address" text,
	"value_wei" text,
	"calldata" text,
	"decoded_summary" json,
	"on_chain_hash" text,
	"confirmation_count" integer DEFAULT 0 NOT NULL,
	"required_confirmations" integer,
	"raw_payload" json,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitored_safes" ADD CONSTRAINT "monitored_safes_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications_sent" ADD CONSTRAINT "notifications_sent_safe_tx_id_safe_transactions_id_fk" FOREIGN KEY ("safe_tx_id") REFERENCES "public"."safe_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications_sent" ADD CONSTRAINT "notifications_sent_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitored_safes_unique" ON "monitored_safes" USING btree ("community_id","safe_address","chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_sent_unique" ON "notifications_sent" USING btree ("safe_tx_id","community_id","notification_type");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_transactions_unique" ON "safe_transactions" USING btree ("safe_tx_hash","chain_id");