require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const crypto = require("crypto");
// const Razorpay = require("razorpay");

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
    await pool.query("SELECT 1");
    console.log("✅ DB connected");
  } catch (err) {
    console.error("❌ DB ERROR:", err.message);
  }
})();

const fs = require("fs");

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}


//================Multer============================
const multer = require("multer");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({ storage });

app.use("/uploads", express.static("uploads"));

//================MIDDLEWARE===================
const verifyToken = (req, res, next) => {
  const auth = req.headers.authorization;

  if (!auth) {
    return res.status(401).json({ error: "No token" });
  }

  const token = auth.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid token" });
  }
};

const verifyAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      code: "ADMIN_ONLY",
      error: "Admin_only ❌"
    });
  }
  next();
};
//============latest draw========================

app.get("/latest-draw", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM draws
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return res.json({ numbers: [] });
    }

    res.json({
      numbers: result.rows[0].numbers,
      created_at: result.rows[0].created_at //IMPORTANT
    });

  } catch (err) {
    console.error("❌ Latest draw error:", err.message);
    res.status(500).json({ error: "Failed to fetch draw" });
  }
});


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
    console.error("❌ Expiry error:", err.message);
  }
}, 60 * 60 * 1000);

// ================== TEST ==================
app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

// ===========================Upload Proof================
app.post("/upload-proof", verifyToken, upload.single("proof"), async (req, res) => {
  try {
    const filePath = "uploads/" + req.file.filename;
    // 🔥 GET winningId FROM FRONTEND
    const { winningId } = req.body;

    if (!winningId) {
      return res.status(400).json({ error: "Winning ID missing ❌" });
    }

    await pool.query(
      "UPDATE winnings SET proof=$1 WHERE id=$2",
      [filePath, winningId]
    );

    res.json({ message: "Proof uploaded ✅" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed ❌" });
  }
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
app.post("/charities", verifyToken, verifyAdmin, async (req, res) => {
  try {

    const { name, description, image } = req.body;

    await pool.query(
      "INSERT INTO charities (name, description, image) VALUES ($1,$2,$3)",
      [name, description, image]
    );

    res.json({ message: "Charity added" });

  } catch (err) {
    console.error("❌ Charities error:", err.message);
    res.status(500).json({ error: "Add charity failed" });
  }
});
// ================== SELECT CHARITY ==================
app.post("/select-charity", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { charity_id } = req.body;

    // 🔒 CHECK SUBSCRIPTION
    const sub = await pool.query(
      "SELECT subscription_end FROM users WHERE id=$1",
      [user_id]
    );

    const end = sub.rows[0]?.subscription_end;

    // ❌ NOT SUBSCRIBED
    if (!end) {
      return res.status(403).json({
        code: "NOT_SUBSCRIBED",
        error: "Please subscribe to select charity ❌"
      });
    }

    // ❌ EXPIRED
    if (new Date(end) < new Date()) {
      const formattedDate = new Date(end).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      });

      return res.status(403).json({
        error: `Subscription expired on ${formattedDate} ❌ Please renew`
      });
    }

    // ✅ UPDATE
    await pool.query(
      "UPDATE users SET charity_id=$1 WHERE id=$2",
      [charity_id, user_id]
    );

    res.json({ message: "Charity selected ✅" });

  } catch (err) {
    console.error("❌ Add charity error:", err.message);
    res.status(500).json({ error: "Something went wrong ❌" });
  }
});
// ================== DRAW ==================
app.post("/draw", verifyToken, verifyAdmin, async (req, res) => {
  try {
    console.log("🎲 Admin triggered draw");

    let { numbers } = req.body;

    // ===============================
    // ✅ MONTHLY CHECK
    // ===============================
    const existing = await pool.query(`
      SELECT * FROM draws
      WHERE DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Kolkata') =
            DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Kolkata')
    `);

    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: "Draw already done this month"
      });
    }

    // ===============================
    // 🔥 MANUAL NUMBERS (POSTMAN)
    // ===============================
    if (numbers && numbers.length > 0) {

      if (numbers.length !== 5) {
        return res.status(400).json({ error: "Enter exactly 5 numbers" });
      }

      for (let n of numbers) {
        if (n < 1 || n > 45) {
          return res.status(400).json({ error: "Numbers must be 1–45" });
        }
      }

      if (new Set(numbers).size !== 5) {
        return res.status(400).json({ error: "No duplicates allowed" });
      }

    } else {
      // ===============================
      // 🔥 RANDOM GENERATION
      // ===============================
      numbers = [];

      while (numbers.length < 5) {
        const n = Math.floor(Math.random() * 45) + 1;
        if (!numbers.includes(n)) numbers.push(n);
      }

      console.log("🎲 Random numbers:", numbers);
    }

    // ===============================
    // ✅ SAVE DRAW
    // ===============================
    const drawInsert = await pool.query(
      "INSERT INTO draws (numbers, created_at) VALUES ($1, NOW()) RETURNING *",
      [numbers]
    );

    const drawId = drawInsert.rows[0].id;

    // ===============================
    // 🔥 GET ACTIVE USERS
    // ===============================
    const usersRes = await pool.query(
      "SELECT id FROM users WHERE subscription_status='active'"
    );

    const users = usersRes.rows;

    // ===============================
    // 🔥 GET SCORES
    // ===============================
    const scoresRes = await pool.query(`
      SELECT user_id, score 
      FROM scores 
      ORDER BY created_at DESC
    `);

    const userScoresMap = {};

    scoresRes.rows.forEach(s => {
      if (!userScoresMap[s.user_id]) userScoresMap[s.user_id] = [];
      if (userScoresMap[s.user_id].length < 5) {
        userScoresMap[s.user_id].push(Number(s.score));
      }
    });

    // ===============================
    // 🔥 MATCH CALCULATION
    // ===============================
    const results = [];

    users.forEach(u => {
      const userNumbers = userScoresMap[u.id] || [];
      const temp = [...numbers];

      let match = 0;

      userNumbers.forEach(num => {
        const index = temp.indexOf(num);
        if (index !== -1) {
          match++;
          temp.splice(index, 1);
        }
      });

      results.push({ user_id: u.id, match });
    });

    // ===============================
    // 🔥 COUNT WINNERS
    // ===============================
    const count3 = results.filter(r => r.match === 3).length;
    const count4 = results.filter(r => r.match === 4).length;
    const count5 = results.filter(r => r.match >= 5).length;

    // ===============================
    // 🔥 POOL CALCULATION
    // ===============================
    const jackpotRes = await pool.query(
      "SELECT amount FROM jackpot LIMIT 1"
    );

    const previousJackpot =
      parseFloat(jackpotRes.rows[0]?.amount) || 0;

    const basePool = users.length * 100;
    const poolAmount = basePool + previousJackpot;

    // ===============================
    // 🔥 PRIZE DISTRIBUTION (CORRECT)
    // ===============================
    // 🔥 PRIZE DISTRIBUTION (FINAL LOGIC)
    const share = {
      3: count3 ? (basePool * 0.25) / count3 : 0,
      4: count4 ? (basePool * 0.35) / count4 : 0,
      5: count5
        ? (previousJackpot + basePool * 0.4) / count5
        : 0
    };
    // ===============================
    // 🔥 SAVE WINNINGS
    // ===============================
    for (let r of results) {
      if (r.match >= 3) {
        // const amount = Number(share[r.match].toFixed(2));

        const amount = Math.floor(share[r.match]);

        await pool.query(
          `INSERT INTO winnings (user_id, amount, draw_id, match_type, created_at)
            VALUES ($1,$2,$3,$4, NOW())          
            ON CONFLICT (user_id, draw_id) DO NOTHING`,
          [
            r.user_id,
            amount,
            drawId,
            r.match === 5
              ? "5 Match 🏆"
              : r.match === 4
                ? "4 Match 🔥"
                : "3 Match 🎉"
          ]
        );
      }
    }

    // ===============================
    // 🎯 JACKPOT LOGIC
    // ===============================
    if (count5 === 0) {
      const newJackpot =
        previousJackpot + Math.floor(basePool * 0.4);

      await pool.query(
        "UPDATE jackpot SET amount=$1",
        [newJackpot]
      );

      console.log("💰 Jackpot carried:", newJackpot);
    } else {
      await pool.query("UPDATE jackpot SET amount=0");
      console.log("🏆 Jackpot won → reset");
    }


    // ===============================
    // ✅ RESPONSE
    // ===============================
    res.json({
      message: "Draw completed ✅",
      numbers,
      winners: {
        match3: count3,
        match4: count4,
        match5: count5
      }
    });

  } catch (err) {
    console.error("❌ Draw error:", err.message);
    res.status(500).json({ error: "Draw failed ❌" });
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
    console.error("❌ Register error:", err.message);
    res.status(500).json({ error: "Register failed" });
  }
});


app.post("/check-result", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;

    // ✅ subscription check
    const userRes = await pool.query(
      "SELECT subscription_end FROM users WHERE id=$1",
      [user_id]
    );

    const user = userRes.rows[0];

    if (!user.subscription_end) {
      return res.status(403).json({
        error: "⚠️ Please subscribe to check results"
      });
    }

    if (new Date(user.subscription_end) < new Date()) {
      return res.status(403).json({
        error: `❌ Subscription expired on ${new Date(
          user.subscription_end
        ).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric"
        })}`
      });
    }

    // ✅ get latest draw
    const draw = await pool.query(`
      SELECT * FROM draws
      ORDER BY created_at DESC
       LIMIT 1
    `);

    if (draw.rows.length === 0) {
      return res.json({ result: "No draw yet" });
    }

    const drawNumber = draw.rows[0].numbers;
    const drawDate = draw.rows[0].created_at;

    // ✅ get user scores
    const scores = await pool.query(
      "SELECT score FROM scores WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5",
      [user_id]
    );

    const userNumbers = scores.rows.map(s => Number(s.score));

    // ✅ match logic
    const countMatches = (userScores, drawNumbers) => {
      const temp = [...drawNumbers];
      let match = 0;

      userScores.forEach(num => {
        const i = temp.indexOf(num);
        if (i !== -1) {
          match++;
          temp.splice(i, 1);
        }
      });

      return match;
    };

    const matchCount = countMatches(userNumbers, drawNumber);

    let resultText = "LOSE 😢";
    if (matchCount === 3) resultText = "3 Match 🎉";
    else if (matchCount === 4) resultText = "4 Match 🔥";
    else if (matchCount >= 5) resultText = "5 Match 🏆";

    // // JACKPOT RESET
    // if (matchCount >= 5) {
    //   await pool.query(`
    // UPDATE jackpot SET amount = 0
    // `);
    // }

    // ✅ just return result (NO calculation)
    res.json({
      result: resultText,
      matches: matchCount,
      numbers: drawNumber,
      created_at: drawDate
    });

  } catch (err) {
    console.error("❌ Result error:", err.message);
    res.status(500).json({ error: "Result failed ❌" });
  }
});

app.post("/approve-winning", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { winning_id } = req.body;

    await pool.query(
      "UPDATE winnings SET status = 'paid' WHERE id = $1 AND status = 'pending'",
      [winning_id]
    );

    res.json({ message: "Approved ✅" });
  } catch (err) {
    console.error("❌ Approve winning error:", err.message);
    res.status(500).json({ error: "Failed" });
  }
});


app.get("/all-winnings", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.id, u.email, w.amount, w.status, w.proof      
      FROM winnings w
      JOIN users u ON u.id = w.user_id
      ORDER BY w.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Winnings fetch error:", err.message);
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
      {
        id: user.id,
        role: user.role || "user"  // ✅ ADD THIS
      },
      process.env.JWT_SECRET || "secret123",
      { expiresIn: "1d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role || "user"  // ✅ ADD THIS
      }
    });

  } catch (err) {
    console.error("❌ Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// ================== USERS ==================
app.get("/users", async (req, res) => {
  const result = await pool.query("SELECT id,email FROM users");
  res.json(result.rows);
});

// ================== SCORES ==================
app.post("/scores", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { score } = req.body;

    // 🔒 CHECK SUBSCRIPTION
    const sub = await pool.query(
      "SELECT subscription_end FROM users WHERE id=$1",
      [user_id]
    );

    const end = sub.rows[0]?.subscription_end;

    // ❌ NOT SUBSCRIBED
    if (!end) {
      return res.status(403).json({
        error: "Please subscribe to add score ❌"
      });
    }
    if (new Date(end) < new Date()) {
      const formattedDate = new Date(end).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      });

      return res.status(403).json({
        error: `Subscription expired on ${formattedDate} ❌ Please renew`
      });
    }


    // 🔒 CHECK IF DRAW ALREADY DONE THIS MONTH
    const drawCheck = await pool.query(`
      SELECT * FROM draws
      WHERE DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Kolkata') =
            DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Kolkata')
    `);

    if (drawCheck.rows.length > 0) {
      return res.status(403).json({
        error: "⚠️ Draw completed. Score entry closed for this month"
      });
    }

    // ✅ VALIDATION


    if (score < 1 || score > 45) {
      return res.status(400).json({ error: "Score 1–45 only" });
    }

    // const date = new Date().toLocaleString("en-US", {
    //   timeZone: "Asia/Kolkata"
    // });
    // ✅ SAVE SCORE
    console.log("🔥 STEP 1 - API HIT");

    await pool.query(
      "INSERT INTO scores (user_id, score, created_at) VALUES ($1,$2, NOW())",
      [user_id, score]
    );

    console.log("🔥 STEP 2 - SCORE INSERTED");

    await pool.query(`
  UPDATE jackpot SET amount = amount + 10 
`);

    console.log("🔥 STEP 3 - JACKPOT UPDATED");

    // ✅ KEEP ONLY LAST 5
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
    console.error("❌ Score error:", err.message);
    res.status(500).json({
      error: "Something went wrong ❌"
    });
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
    console.error("❌ Scores fetch error:", err.message);
    res.status(500).json({ error: "Error fetching scores" });
  }
});

// ================== DASHBOARD ==================
app.get("/dashboard", verifyToken, async (req, res) => {
  try {
    const id = req.user.id;
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
    console.error("❌ Dashboard error:", err.message);
    res.status(500).json({ error: "Dashboard error" });
  }
});

//==================PAYMENT STATUS=================

app.post("/verify-payment", verifyToken, async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      type
    } = req.body;
    const user_id = req.user.id;

    // 🚨 MUST HAVE THESE
    if (!razorpay_payment_id || !type) {
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
    console.error("❌ Verify payment error:", err.message);
    res.status(500).json({ error: "Verification failed ❌" });
  }
});


//====================check subscription=========================

app.post("/activate-subscription", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;

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
    console.error("❌ Activate subscription error:", err.message);
    res.status(500).json({ error: "Activation failed" });
  }
});


app.post("/check-subscription", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;

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
    console.error("❌ Check subscription error:", err.message);
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
//===================jackpot=============
app.get("/jackpot", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT amount FROM jackpot LIMIT 1"
    );

    // ✅ COUNT ACTIVE USERS
    const usersRes = await pool.query(
      "SELECT COUNT(*) FROM users WHERE subscription_status='active'"
    );

    const activeUsers = Number(usersRes.rows[0].count);

    // ✅ BASE POOL
    const basePool = activeUsers * 100;

    res.json({
      jackpot: result.rows[0]?.amount || 0,
      basePool // 🔥 THIS WAS MISSING
    });

  } catch (err) {
    console.error("❌ Jackpot error:", err.message);
    res.status(500).json({ error: "Failed to fetch jackpot" });
  }
});



//===================reject button===========
app.post("/reject-winning", verifyToken, verifyAdmin, async (req, res) => {
  const { winning_id } = req.body;

  await pool.query(
    "UPDATE winnings SET status='rejected' WHERE id=$1",
    [winning_id]
  );

  res.json({ message: "Rejected ❌" });
});


// ================= SIMULATE DRAW =================
app.post("/simulate-draw", verifyToken, verifyAdmin, async (req, res) => {
  try {
    // 🔥 1️⃣ Get ONLY ACTIVE (subscribed) users
    const usersRes = await pool.query(`
      SELECT id, email FROM users 
      WHERE subscription_status = 'active'
    `);

    const users = usersRes.rows;

    if (users.length === 0) {
      return res.json({
        numbers: [],
        results: [],
        message: "No active users"
      });
    }

    // 📊 2️⃣ Get all scores (latest first)
    const scoresRes = await pool.query(`
      SELECT user_id, score 
      FROM scores 
      ORDER BY created_at DESC
    `);

    // 👤 3️⃣ Last 5 scores per user
    const userScoresMap = {};

    scoresRes.rows.forEach(s => {
      // ❗ only active users
      if (!users.find(u => u.id === s.user_id)) return;

      if (!userScoresMap[s.user_id]) {
        userScoresMap[s.user_id] = [];
      }

      if (userScoresMap[s.user_id].length < 5) {
        userScoresMap[s.user_id].push(Number(s.score));
      }
    });

    let allScores = [];

    Object.values(userScoresMap).forEach(arr => {
      allScores.push(...arr);
    });

    // ❗ duplicates remove
    allScores = [...new Set(allScores)];

    if (allScores.length === 0) {
      return res.json({
        numbers: [],
        results: [],
        message: "No scores found"
      });
    }

    // 🎲 5️⃣ Generate numbers FROM USER SCORES ONLY
    const numbers = [];

    while (numbers.length < 5 && allScores.length > 0) {
      const index = Math.floor(Math.random() * allScores.length);
      const n = allScores[index];

      if (!numbers.includes(n)) {
        numbers.push(n);
      }
    }

    // 🎯 6️⃣ Match calculation (same as real draw)
    const results = [];

    users.forEach(u => {
      const scores = userScoresMap[u.id] || [];

      const temp = [...numbers];
      let match = 0;

      scores.forEach(num => {
        const index = temp.indexOf(num);
        if (index !== -1) {
          match++;
          temp.splice(index, 1);
        }
      });

      results.push({
        user_id: u.id,
        email: u.email,
        scores,
        matchCount: match
      });
    });

    // 💰 PRIZE CALCULATION
    const count3 = results.filter(r => r.matchCount === 3).length;
    const count4 = results.filter(r => r.matchCount === 4).length;
    const count5 = results.filter(r => r.matchCount >= 5).length;

    const basePool = users.length * 100;

    const jackpotRes = await pool.query(
      "SELECT amount FROM jackpot LIMIT 1"
    );

    const previousJackpot =
      parseFloat(jackpotRes.rows[0]?.amount) || 0;

    // ✅ RULE:
    const poolAmount = basePool + previousJackpot;

    // 🔥 PRIZE DISTRIBUTION (FINAL LOGIC)
    const share = {
      3: count3 ? (basePool * 0.25) / count3 : 0,
      4: count4 ? (basePool * 0.35) / count4 : 0,
      5: count5
        ? (previousJackpot + basePool * 0.4) / count5
        : 0
    };

    results.forEach(r => {
      if (r.matchCount >= 3) {
        r.prize =
          r.matchCount === 5
            ? share[5]
            : r.matchCount === 4
              ? share[4]
              : share[3];
      } else {
        r.prize = 0;
      }
    });

    // 📤 7️⃣ Response
    res.json({
      numbers,
      results,
      poolAmount
    });

  } catch (err) {
    console.error("❌ Simulation error:", err.message);
    res.status(500).json({
      error: "Simulation failed ❌"
    });
  }
});

const Razorpay = require("razorpay");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.post("/create-order", verifyToken, async (req, res) => {
  try {
    const { amount } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    res.json(order);
  } catch (err) {
    console.error("ORDER ERROR:", err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// ================== SERVER ==================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
