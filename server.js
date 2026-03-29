require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");

const app = express();

// ================== ✅ FINAL CORS FIX ==================
const cors = require("cors");

app.use(cors({
  origin: true,   // ✅ allow all origins dynamically
  credentials: true
}));
app.use(express.json());

// ================== DB CHECK ==================
(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ DB CONNECTED:", res.rows[0].now);
  } catch (err) {
    console.error("❌ DB ERROR:", err.message);
  }
})();

// ================== TEST ==================
app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

// ================== REGISTER ==================
app.post("/users", async (req, res) => {
  try {
    const { email, password } = req.body;

    const exists = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (exists.rows.length > 0) {
      return res.status(400).json({ error: "User exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1,$2) RETURNING id,email",
      [email, hash]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Register failed" });
  }
});

// ================== LOGIN ==================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: "Wrong password" });
    }

    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET || "secret123",
      { expiresIn: "1d" }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ================== USERS ==================
app.get("/users", async (req, res) => {
  const result = await pool.query("SELECT id,email FROM users");
  res.json(result.rows);
});

// ================== SCORES ==================
app.post("/scores", async (req, res) => {
  try {
    const { user_id, score, created_at } = req.body;

    if (!user_id || !score) {
      return res.status(400).json({ error: "Missing data" });
    }

    if (score < 1 || score > 45) {
      return res.status(400).json({ error: "Score 1–45 only" });
    }

    const date = created_at || new Date();

    await pool.query(
      "INSERT INTO scores (user_id, score, created_at) VALUES ($1,$2,$3)",
      [user_id, score, date]
    );

    await pool.query(`
      DELETE FROM scores
      WHERE id NOT IN (
        SELECT id FROM scores
        WHERE user_id=$1
        ORDER BY created_at DESC
        LIMIT 5
      ) AND user_id=$1
    `, [user_id]);

    res.json({ message: "Score saved" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================== GET SCORES ==================
app.get("/scores", async (req, res) => {
  const result = await pool.query("SELECT * FROM scores");
  res.json(result.rows);
});

// ================== CHARITIES ==================
app.get("/charities", async (req, res) => {
  const result = await pool.query("SELECT * FROM charities");
  res.json(result.rows);
});

// ================== ADD CHARITY ==================
app.post("/charities", async (req, res) => {
  try {
    const { name, description, image } = req.body;

    await pool.query(
      "INSERT INTO charities (name, description, image) VALUES ($1,$2,$3)",
      [name, description, image]
    );

    res.json({ message: "Charity added" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Add charity failed" });
  }
});

// ================== SELECT CHARITY ==================
app.post("/select-charity", async (req, res) => {
  const { user_id, charity_id } = req.body;

  await pool.query(
    "UPDATE users SET charity_id=$1 WHERE id=$2",
    [charity_id, user_id]
  );

  res.json({ message: "Selected" });
});

// ================== SUBSCRIBE ==================
app.post("/subscribe", async (req, res) => {
  try {
    const { user_id, type } = req.body;

    let days = type === "yearly" ? 365 : 30;

    await pool.query(`
      UPDATE users 
      SET subscription_status='active',
          subscription_type=$1,
          subscription_end = NOW() + INTERVAL '${days} days'
      WHERE id=$2
    `, [type, user_id]);

    res.json({ message: "Subscribed" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Subscription failed" });
  }
});

// ================== DASHBOARD ==================
app.get("/dashboard/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const user = await pool.query(`
      SELECT u.*, c.name AS charity_name
      FROM users u
      LEFT JOIN charities c ON u.charity_id = c.id
      WHERE u.id=$1
    `, [id]);

    const scores = await pool.query(`
      SELECT * FROM scores
      WHERE user_id=$1
      ORDER BY created_at DESC
    `, [id]);

    const winnings = await pool.query(`
      SELECT * FROM winnings WHERE user_id=$1
    `, [id]);

    res.json({
      user: user.rows[0],
      scores: scores.rows,
      winnings: winnings.rows
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dashboard error" });
  }
});

// ================== DRAW ==================
app.post("/draw", async (req, res) => {
  try {
    const number = Math.floor(Math.random() * 45) + 1;

    const result = await pool.query(
      "INSERT INTO draws (numbers) VALUES ($1) RETURNING *",
      [[number]]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Draw failed" });
  }
});

// ================== RESULT ==================
app.post("/check-result", async (req, res) => {
  try {
    const { user_id } = req.body;

    const draw = await pool.query(
      "SELECT * FROM draws ORDER BY id DESC LIMIT 1"
    );

    if (draw.rows.length === 0) {
      return res.json({ result: "No draw yet" });
    }

    const drawNumber = draw.rows[0].numbers[0];

    const scores = await pool.query(
      "SELECT * FROM scores WHERE user_id=$1",
      [user_id]
    );

    const matchCount = scores.rows.filter(
      s => s.score === drawNumber
    ).length;

    let resultText = "LOSE 😢";
    if (matchCount >= 1) resultText = "3 Match 🎉";
    if (matchCount >= 2) resultText = "4 Match 🔥";
    if (matchCount >= 3) resultText = "5 Match 🏆";

    res.json({ result: resultText, number: drawNumber });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Result failed" });
  }
});

// ================== LEADERBOARD ==================
app.get("/leaderboard", async (req, res) => {
  const result = await pool.query(`
    SELECT u.email, MAX(s.score) as best_score
    FROM scores s
    JOIN users u ON u.id = s.user_id
    GROUP BY u.email
    ORDER BY best_score DESC
    LIMIT 5
  `);

  res.json(result.rows);
});

// ================== SERVER ==================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});