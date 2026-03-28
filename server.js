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
const corsOptions = {
  origin: "https://golf-frontend-mu.vercel.app",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// ================== TEST ==================
app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

// ================== REGISTER ==================
app.post("/users", async (req, res) => {
  try {
    const { email, password } = req.body;

    const exists = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1,$2) RETURNING id,email",
      [email, hash]
    );

    res.json(result.rows[0]);

  } catch (err) {
    res.status(500).json({ error: "Register failed" });
  }
});

// ================== LOGIN ==================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Wrong password" });
    }

    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET || "secret123",
      { expiresIn: "1d" }
    );

    res.json({ token, user: { id: user.id, email: user.email } });

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ================== SCORES ==================
app.post("/scores", async (req, res) => {
  try {
    const { user_id, score, created_at } = req.body;

    // ✅ validation
    if (score < 1 || score > 45) {
      return res.status(400).json({ error: "Score must be 1–45" });
    }

    await pool.query(
      "INSERT INTO scores (user_id, score, created_at) VALUES ($1,$2,$3)",
      [user_id, score, created_at]
    );

    // keep last 5
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
    res.status(500).json({ error: "Score error" });
  }
});

// ================== CHARITY ==================
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

  res.json({
    user: user.rows[0],
    scores: scores.rows,
    winnings: [] // placeholder
  });
});

// ================== DRAW ==================
app.post("/draw", async (req, res) => {
  const number = Math.floor(Math.random() * 45) + 1; // ✅ PRD fix

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

  const drawNumber = draw.rows[0].numbers;

  let matchCount = scores.rows.filter(s => s.score === drawNumber).length;

  let resultText = "LOSE 😢";
  if (matchCount >= 1) resultText = "3 Match 🎉";
  if (matchCount >= 2) resultText = "4 Match 🔥";
  if (matchCount >= 3) resultText = "5 Match 🏆";

  res.json({
    result: resultText,
    number: drawNumber
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
