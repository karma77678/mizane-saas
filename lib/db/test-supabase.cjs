const { Client } = require("pg");

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log("Connexion PostgreSQL : OK");

    const result = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS db_user,
        to_regclass('public.users') AS users,
        to_regclass('public.workspace_members') AS workspace_members,
        to_regclass('public.workspace_member') AS workspace_member
    `);

    console.table(result.rows);

    await client.query(
      "SELECT id FROM public.users WHERE email = $1 LIMIT $2",
      ["oussamakarmaoui7@gmail.com", 1]
    );

    console.log("Requête users : OK");
  } catch (error) {
    console.error("ERREUR POSTGRESQL :", error.message);
    console.error("Code :", error.code);
    console.error("Table :", error.table);
    console.error("Colonne :", error.column);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
