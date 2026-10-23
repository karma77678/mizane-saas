const { Client } = require("pg");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  try {
    await client.connect();
    console.log("✅ Connexion Supabase réussie !");
    const res = await client.query("SELECT current_database(), current_user;");
    console.table(res.rows);
  } catch (err) {
    console.error("❌ Erreur de connexion :", err.message);
  } finally {
    await client.end();
  }
}

main();