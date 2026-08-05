CREATE TABLE "relay_environment_lifecycle_leases" (
	"user_id" varchar(191),
	"environment_id" varchar(191),
	"owner_id" varchar(64) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_environment_lifecycle_leases_pkey" PRIMARY KEY("user_id","environment_id")
);
