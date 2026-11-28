INSERT INTO alchemy_postgres_widgets (id, name)
VALUES (1, 'seeded')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
