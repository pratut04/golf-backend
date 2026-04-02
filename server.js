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
const waitForDB = async () => {
  let connected = false;

  while (!connected) {
    try {
      const res = await pool.query("SELECT NOW()");
      console.log("✅ DB CONNECTED:", res.rows[0].now);
      connected = true;
    } catch (err) {
      console.log("⏳ Waiting for DB...");
      await new Promise(res => setTimeout(res, 5000));
    }
  }
};

// WAIT BEFORE STARTING SERVER
(async () => {
  await waitForDB();

  app.listen(process.env.PORT || 5000, () => {
    console.log("🚀 Server running");
  });
})();


// ================== AUTO EXPIRE (REAL AUTO) ==================
setInterval(async () => {
  try {
    console.log("⏰ Running auto-expiry check...");

    await pool.query(`
      UPDATE users
      SET subscription_status = 'inactive'
      WHERE subscription_status = 'active'
      AND subscription_end IS NOT NULL
      AND subscription_end < NOW()
    `);

    console.log("✅ Expiry updated");
  } catch (err) {
    console.error("❌ Expiry error:", err);
  }
}, 60 * 60 * 1000); 

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

app.post("/check-result", async (req, res) => {
  try {
    const { user_id } = req.body;
    // 1️⃣ GET LATEST DRAW
    const draw = await pool.query(
      "SELECT * FROM draws ORDER BY created_at DESC LIMIT 1"
    );

    if (draw.rows.length === 0) {
      return res.json({ result: "No draw yet" });
    }

    const drawNumber = draw.rows[0].numbers;
    const drawId = draw.rows[0].id;

    // 2️⃣ GET USER LAST 5 SCORES
    const scores = await pool.query(
      "SELECT score FROM scores WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5",
      [user_id]
    );

    // 3️⃣ MATCH COUNT
    const matchCount = scores.rows.filter(s =>
      drawNumber.includes(Number(s.score))
    ).length;

    // 4️⃣ RESULT LOGIC
    let resultText = "LOSE 😢";

    if (matchCount === 3) resultText = "3 Match 🎉";
    else if (matchCount === 4) resultText = "4 Match 🔥";
    else if (matchCount >= 5) resultText = "5 Match 🏆";

    // 5️⃣ CHECK IF WINNING ALREADY INSERTED
    const existing = await pool.query(
      "SELECT * FROM winnings WHERE user_id=$1 AND draw_id=$2",
      [user_id, drawId]
    );

    // 6️⃣ INSERT ONLY ONCE
    if (existing.rows.length === 0 && matchCount >= 1) {
      await pool.query(
        "INSERT INTO winnings (user_id, amount, draw_id, match_type) VALUES ($1,$2,$3,$4)",
        [user_id, matchCount * 100, drawId, resultText]
      );
    }

    // 7️⃣ ALWAYS RETURN RESULT ✅
    res.json({
      result: resultText,
      numbers: drawNumber,
      matches: matchCount
    });

  } catch (err) {
    console.error("CHECK RESULT ERROR:", err);
    res.status(500).json({ error: "Result failed ❌" });
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

app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      user_id,
      type
    } = req.body;

    // 🚨 MUST HAVE THESE
    if (!razorpay_payment_id || !user_id || !type) {
      return res.status(400).json({ error: "Missing payment data ❌" });
    }

    // 🔒 SIGNATURE VERIFY (if available)
    if (razorpay_order_id && razorpay_signature) {
      const generatedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ error: "Invalid signature ❌" });
      }
    }

    // 📅 PLAN LOGIC
    let interval = "30 days";
    if (type === "yearly") {
      interval = "365 days";
    }

    // ✅ ACTIVATE + SAVE TYPE
    const result = await pool.query(
      `UPDATE users 
       SET subscription_status = 'active',
           subscription_type = $2,
           subscription_end = NOW() + INTERVAL '${interval}'
       WHERE id = $1
       RETURNING subscription_status, subscription_type, subscription_end`,
      [user_id, type]
    );

    console.log("PAYMENT VERIFIED:", result.rows[0]);

    res.json({
      success: true,
      message: "Payment verified & subscription activated ✅",
      data: result.rows[0]
    });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed ❌" });
  }
});


//====================check subscription=========================

app.post("/activate-subscription", async (req, res) => {
  try {
    const { user_id } = req.body;

    const result = await pool.query(
      `UPDATE users 
       SET subscription_status = 'active',
           subscription_end = NOW() + INTERVAL '30 days'
       WHERE id = $1
       RETURNING subscription_status, subscription_end`,
      [user_id]
    );

    console.log("ACTIVATED:", result.rows[0]);

    res.json({
      message: "Subscription activated ✅",
      data: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Activation failed" });
  }
});


app.post("/check-subscription", async (req, res) => {
  try {
    const { user_id } = req.body;

    const result = await pool.query(`
      SELECT 
        subscription_status,
        subscription_type,
        subscription_end,
        CASE 
          WHEN subscription_end IS NULL OR subscription_end < NOW()
          THEN 'inactive'
          ELSE 'active'
        END AS real_status
      FROM users
      WHERE id = $1
    `, [user_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      status: user.real_status,
      subscription_type: user.subscription_type,
      subscription_end: user.subscription_end
    });

  } catch (err) {
    console.error(err);
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
