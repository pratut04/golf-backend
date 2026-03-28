require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");

const app = express();

// ================== DB CHECK ==================
console.log("🚀 DB test started...");

(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ DB CONNECTED:", res.rows[0].now);
  } catch (err) {
    console.error("❌ DB CONNECTION ERROR:", err.message);
  }
})();

// ================== MIDDLEWARE ==================
app.use(cors());
app.use(express.json());

// ================== TEST ==================
app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

// ================== REGISTER ==================
app.post("/users", async (req, res) => {
  try {
    const { email, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id,email",
      [email, hash]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Register failed" });
  }
});

// ================== LOGIN ==================
app.post("/login", async (req, res) => {
  try {
    console.log("LOGIN HIT:", req.body);

    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];

    // 🔐 Compare password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: "Wrong password" });
    }

    // 🔐 Create token
    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    // ✅ Send token + user
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== USERS ==================
app.get("/users", async (req, res) => {
  const result = await pool.query("SELECT id,email FROM users");
  res.json(result.rows);
});

// ================== SCORES ==================
app.post("/scores", async (req, res) => {
  const { user_id, score } = req.body;

  await pool.query(
    "INSERT INTO scores (user_id,score) VALUES ($1,$2)",
    [user_id, score]
  );

  res.json({ message: "Score added" });
});

app.get("/scores", async (req, res) => {
  const result = await pool.query("SELECT * FROM scores");
  res.json(result.rows);
});

// ================== SUBSCRIBE ==================
app.post("/subscribe", async (req, res) => {
  const { user_id } = req.body;

  const result = await pool.query(
    "UPDATE users SET subscription_status='active' WHERE id=$1 RETURNING *",
    [user_id]
  );

  res.json(result.rows[0]);
});

// ================== CHARITIES ==================
app.get("/charities", async (req, res) => {
  const result = await pool.query("SELECT * FROM charities");
  res.json(result.rows);
});

app.post("/select-charity", async (req, res) => {
  const { user_id, charity_id } = req.body;

  await pool.query(
    "UPDATE users SET charity_id=$1 WHERE id=$2",
    [charity_id, user_id]
  );

  res.json({ message: "Charity selected" });
});

// ================== DASHBOARD ==================
app.get("/dashboard/:id", async (req, res) => {
  const id = req.params.id;

  const user = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
  const scores = await pool.query("SELECT * FROM scores WHERE user_id=$1", [id]);

  res.json({
    user: user.rows[0],
    scores: scores.rows
  });
});

// ================== DRAW ==================
app.post("/draw", async (req, res) => {
  const number = Math.floor(Math.random() * 100);

  const result = await pool.query(
    "INSERT INTO draws (numbers) VALUES ($1) RETURNING *",
    [number]
  );

  res.json(result.rows[0]);
});

// ================== RESULT ==================
app.post("/check-result", async (req, res) => {
  const { user_id } = req.body;

  const draw = await pool.query(
    "SELECT * FROM draws ORDER BY id DESC LIMIT 1"
  );

  const scores = await pool.query(
    "SELECT * FROM scores WHERE user_id=$1",
    [user_id]
  );

  let win = false;

  scores.rows.forEach(s => {
    if (s.score === draw.rows[0].numbers) win = true;
  });

  res.json({
    result: win ? "WIN 🎉" : "LOSE 😢",
    number: draw.rows[0].numbers
  });
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
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
