CREATE TABLE "todos" (
	"id" serial PRIMARY KEY,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

