CREATE TABLE "relay_upstream_api_pauses" (
	"api" varchar(64) PRIMARY KEY,
	"paused_until_ms" bigint NOT NULL
);
