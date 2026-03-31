require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const app = express();

// ================== CORS ==================
app.use(cors({
  origin: true,
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

// ==================  CHARITIES (FIX ADDED) ==================
app.get("/charities", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM charities");
    res.json(result.rows);
  } catch (err) {
    console.error("CHARITIES ERROR:", err);
    res.status(500).json({ error: "Failed to fetch charities" });
  }
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
// ================== DRAW ==================
app.post("/draw", async (req, res) => {
  try {
    const numbers = [];

    while (numbers.length < 5) {
      const n = Math.floor(Math.random() * 45) + 1;
      if (!numbers.includes(n)) {
        numbers.push(n);
      }
    }

    console.log("DRAW NUMBERS:", numbers);

    await pool.query(
      "INSERT INTO draws (numbers) VALUES ($1) RETURNING *",
      [numbers]
    );

    res.json({
      message: "Draw completed",
      numbers
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Draw failed" });
  }
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

// ================== RESULT ==================
app.post("/check-result", async (req, res) => {
  try {
    const { user_id } = req.body;

    //  1. GET LATEST DRAW
    const draw = await pool.query(
      "SELECT * FROM draws ORDER BY created_at DESC LIMIT 1"
    );

    if (draw.rows.length === 0) {
      return res.json({ result: "No draw yet" });
    }

    const drawNumber = draw.rows[0].numbers;
    const drawId = draw.rows[0].id; // IMPORTANT

    //  2. CHECK IF ALREADY CHECKED
    const existing = await pool.query(
      "SELECT * FROM winnings WHERE user_id = $1 AND draw_id = $2",
      [user_id, drawId]
    );

    if (existing.rows.length > 0) {
      return res.json({
        result: "Already checked ⚠️",
        numbers: drawNumber
      });
    }

    //  3. GET USER SCORES
    const scores = await pool.query(
      "SELECT * FROM scores WHERE user_id=$1",
      [user_id]
    );

    const matchCount = scores.rows.filter(
      s => drawNumber.includes(s.score)
    ).length;

    let resultText = "LOSE 😢";
    if (matchCount >= 1) resultText = "3 Match 🎉";
    if (matchCount >= 2) resultText = "4 Match 🔥";
    if (matchCount >= 3) resultText = "5 Match 🏆";

    //  4. INSERT ONLY ONCE
    if (matchCount >= 1) {
      await pool.query(
        "INSERT INTO winnings (user_id, amount, draw_id) VALUES ($1, $2, $3)",
        [user_id, matchCount * 100, drawId]
      );
    }

    res.json({ result: resultText, numbers: drawNumber });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Result failed" });
  }
});
app.post("/approve-winning", async (req, res) => {
  try {
    const { winning_id } = req.body;

    await pool.query(
      "UPDATE winnings SET status = 'paid' WHERE id = $1 AND status = 'pending'",
      [winning_id]
    );

    res.json({ message: "Approved ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed" });
  }
});


app.get("/all-winnings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.id, u.email, w.amount, w.status
      FROM winnings w
      JOIN users u ON u.id = w.user_id
      ORDER BY w.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fetch failed" });
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
    const { user_id, score } = req.body;

    if (!user_id || !score) {
      return res.status(400).json({ error: "Missing data" });
    }

    if (score < 1 || score > 45) {
      return res.status(400).json({ error: "Score 1–45 only" });
    }

    const date = new Date();

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
  try {
    const result = await pool.query(`
      SELECT scores.*, users.email
      FROM scores
      JOIN users ON users.id = scores.user_id
      ORDER BY scores.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching scores" });
  }
});

// ================== DASHBOARD ==================
app.get("/dashboard/:id", async (req, res) => {
  try {
    const id = req.params.id;

    console.log("Dashboard API called:", id);

    const user = await pool.query(`
      SELECT u.*, c.name AS charity_name
      FROM users u
      LEFT JOIN charities c ON u.charity_id = c.id
      WHERE u.id=$1
    `, [id]);

    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const scores = await pool.query(`
      SELECT * FROM scores
      WHERE user_id=$1
      ORDER BY created_at DESC
      LIMIT 5
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
    console.error("DASHBOARD ERROR:", err);
    res.status(500).json({ error: "Dashboard error" });
  }
});

//==================PAYMENT STATUS=================

app.post("/activate-subscription", async (req, res) => {
  try {
    const { user_id } = req.body;

    await pool.query(
      `UPDATE users 
       SET subscription_status = 'active',
           subscription_end = NOW() + INTERVAL '30 days'
       WHERE id = $1`,
      [user_id]
    );

    res.json({ message: "Subscription activated ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Activation failed" });
  }
});


app.post("/check-subscription", async (req, res) => {
  try {
    const { user_id } = req.body;

    const result = await pool.query(
      "SELECT subscription_end FROM users WHERE id = $1",
      [user_id]
    );

    // SAFETY CHECK
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const end = result.rows[0].subscription_end;

    let status = "active"; 

    // CHECK EXPIRY
    if (!end || new Date(end) < new Date()) {
      await pool.query(
        "UPDATE users SET subscription_status = 'inactive' WHERE id = $1",
        [user_id]
      );

      status = "inactive"; 
    }

    // RETURN STATUS
    res.json({
      success: true,
      status: status
    });

  } catch (err) {
    console.error("CHECK SUB ERROR:", err);
    res.status(500).json({ error: "Server error" });
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
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});