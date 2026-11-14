INSERT INTO alchemy_mysql_widgets (id, name)
VALUES (1, 'seeded')
ON DUPLICATE KEY UPDATE name = VALUES(name);
