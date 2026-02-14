CREATE TABLE "leaderboard_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"period" varchar(16) NOT NULL,
	"period_key" varchar(16) NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"rank" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_profiles" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"xp_total" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"last_quiz_date" date,
	"badges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quizzes_completed" integer DEFAULT 0 NOT NULL,
	"perfect_scores" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leaderboard_user_period_idx" ON "leaderboard_entries" USING btree ("user_id","period","period_key");--> statement-breakpoint
CREATE INDEX "leaderboard_period_xp_idx" ON "leaderboard_entries" USING btree ("period","period_key","xp");