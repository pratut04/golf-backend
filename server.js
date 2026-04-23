require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
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

// const fs = require("fs");

// // main uploads folder
// if (!fs.existsSync("uploads")) {
//   fs.mkdirSync("uploads");
// }

// // 🔥 new charities folder
// if (!fs.existsSync("uploads/charities")) {
//   fs.mkdirSync("uploads/charities", { recursive: true });
// }


//================Multer============================
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

// 🔥 storage (REPLACE diskStorage)
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    if (file.fieldname === "proof") {
      return {
        folder: "proofs",
        allowed_formats: ["jpg", "png", "jpeg"],
      };
    }

    return {
      folder: "charities",
      allowed_formats: ["jpg", "png", "jpeg"],
    };
  },
});

// 🔥 upload
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
});



//================MIDDLEWARE===================
const verifyToken = (req, res, next) => {
  const auth = req.headers.authorization;

  if (!auth) {
    return res.status(401).json({
      success: false,
      code: "NO_TOKEN",
      message: "No token provided"
    });
  }

  const token = auth.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({
      success: false,
      code: "INVALID_TOKEN",
      message: "Invalid token"
    });
  }
};

const verifyAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      code: "ADMIN_ONLY",
      message: "Admin access required"
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
      return res.json({
        success: true,
        numbers: []
      });
    }

    res.json({
      success: true,
      numbers: result.rows[0].numbers,
      created_at: result.rows[0].created_at //IMPORTANT
    });

  } catch (err) {
    console.error("❌ Latest draw error:", err.message);
    res.status(500).json({
      success: false,
      code: "LATEST_DRAW_FAILED",
      message: "Failed to fetch draw"
    });
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


// ================== CLEAN TEMP USERS ==================
setInterval(async () => {
  try {
    console.log("🧹 Cleaning expired temp users...");

    await pool.query(`
      DELETE FROM temp_users
      WHERE otp_expiry < NOW()
    `);

    console.log("✅ Expired temp users deleted");
  } catch (err) {
    console.error("❌ Cleanup error:", err.message);
  }
}, 10 * 60 * 1000); // every 10 min

// ================== TEST ==================
app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

// ===========================Upload Proof================
app.post("/upload-proof", verifyToken, upload.single("proof"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        code: "NO_FILE",
        message: "File is required"
      });
    }
    const filePath = req.file.path;
    // 🔥 GET winningId FROM FRONTEND
    const { winningId } = req.body;

    if (!winningId) {
      return res.status(400).json({
        success: false,
        code: "MISSING_WINNING_ID",
        message: "Winning ID is required"
      });
    }

    await pool.query(
      "UPDATE winnings SET proof=$1 WHERE id=$2",
      [filePath, winningId]
    );

    res.json({
      success: true,
      message: "Proof uploaded"
    });

  } catch (err) {
    console.error("❌ Upload proof error:", err.message);
    res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Upload failed ❌"
    });
  }
});
// ==================  CHARITIES (FIX ADDED) ==================
app.get("/charities", async (req, res) => {
  try {
    const result = await pool.query(`
     SELECT 
  c.*,

  -- ✅ correct user count
  (
    SELECT COUNT(*)
    FROM users u
    WHERE u.charity_id = c.id
  ) AS users_count,

  -- ✅ correct images (NO DUPLICATES)
  COALESCE(
    (
      SELECT JSON_AGG(
        JSON_BUILD_OBJECT(
          'id', ci.id,
          'image', ci.image
        )
      )
      FROM charity_images ci
      WHERE ci.charity_id = c.id
    ),
    '[]'
  ) AS images

FROM charities c
ORDER BY c.created_at DESC;
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (err) {
    console.error("CHARITIES ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch charities"
    });
  }
});
// ================== ADD CHARITY ==================
app.post(
  "/charities",
  verifyToken,
  verifyAdmin,
  upload.array("images", 5), // max 5 images,
  async (req, res) => {
    try {
      const { name, description } = req.body;

      const result = await pool.query(
        "INSERT INTO charities (name, description) VALUES ($1,$2) RETURNING id",
        [name, description]
      );

      const charityId = result.rows[0].id;

      //  multiple images
      if (req.files && req.files.length > 0) {
        for (let file of req.files) {

          await pool.query(
            "INSERT INTO charity_images (charity_id, image) VALUES ($1,$2)",
            [charityId, file.path] // ✅ FIX
          );
        }
      }

      res.json({
        success: true,
        message: "Charity added ✅"
      });

    } catch (err) {
      console.error("❌ Add charity error:", err.message);
      res.status(500).json({
        success: false,
        message: "Failed to add charity"
      });
    }
  }
);
// ================== SELECT CHARITY ==================
app.post("/select-charity", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { charity_id } = req.body;

    // ===============================
    // 🔒 SUBSCRIPTION CHECK
    // ===============================
    const sub = await pool.query(
      "SELECT subscription_end FROM users WHERE id=$1",
      [user_id]
    );

    const end = sub.rows[0]?.subscription_end;

    if (!end) {
      return res.status(403).json({
        success: false,
        code: "NOT_SUBSCRIBED",
        message: "Please subscribe to select charity"
      });
    }

    if (new Date(end) < new Date()) {
      return res.status(403).json({
        success: false,
        code: "SUBSCRIPTION_EXPIRED",
        message: "Subscription expired",
        expiry: end
      });
    }

    // ===============================
    // ✅ CHECK CHARITY EXISTS
    // ===============================
    const charityCheck = await pool.query(
      "SELECT id FROM charities WHERE id=$1",
      [charity_id]
    );

    if (charityCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CHARITY",
        message: "Charity not found"
      });
    }

    // ===============================
    // 🚫 CHECK ALREADY SELECTED (PUT HERE)
    // ===============================
    const already = await pool.query(
      "SELECT charity_id FROM users WHERE id=$1",
      [user_id]
    );

    if (Number(already.rows[0].charity_id) === Number(charity_id)) {
      return res.status(400).json({
        success: false,
        code: "ALREADY_SELECTED",
        message: "Charity already selected"
      });
    }

    // ===============================
    // ✅ UPDATE
    // ===============================
    await pool.query(
      "UPDATE users SET charity_id=$1 WHERE id=$2",
      [charity_id, user_id]
    );

    res.json({
      success: true,
      message: "Charity selected ✅"
    });

  } catch (err) {
    console.error("❌ Select charity error:", err.message);
    res.status(500).json({
      success: false,
      message: "Something went wrong"
    });
  }
});


//==============my-charity========================

app.get("/my-charity", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;

    const result = await pool.query(`
      SELECT c.*
      FROM users u
      LEFT JOIN charities c ON u.charity_id = c.id
      WHERE u.id = $1
    `, [user_id]);

    res.json({
      success: true,
      data: result.rows[0] || null
    });

  } catch (err) {
    console.error("❌ My charity error:", err.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch user charity"
    });
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
        success: false,
        code: "DRAW_ALREADY_DONE",
        message: "Draw already done this month"
      });
    }

    // ===============================
    // 🔥 MANUAL NUMBERS (POSTMAN)
    // ===============================
    if (numbers && numbers.length > 0) {

      if (numbers.length !== 5) {
        return res.status(400).json({
          success: false,
          code: "INVALID_COUNT",
          message: "Enter exactly 5 numbers"
        });
      }

      for (let n of numbers) {
        if (n < 1 || n > 45) {
          return res.status(400).json({
            success: false,
            code: "INVALID_RANGE",
            message: "Numbers must be between 1 and 45"
          });
        }
      }

      if (new Set(numbers).size !== 5) {
        return res.status(400).json({
          success: false,
          code: "DUPLICATE_NUMBERS",
          message: "Duplicate numbers not allowed"
        });
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
    const usersRes = await pool.query(`
  SELECT id
  FROM users
  WHERE subscription_start <= $1
  AND subscription_end >= $1
`, [drawInsert.rows[0].created_at]);

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
        const amount = Number(share[r.match].toFixed(2));

        //const amount = Math.floor(share[r.match]);

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
      success: true,
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
    res.status(500).json({
      success: false,
      code: "DRAW_FAILED",
      message: "Draw failed"
    });
  }
});


// ================== REGISTER ==================
app.post("/users", async (req, res) => {
  const { email, password } = req.body;

  try {
    // 🔍 Check real users table
    const exists = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (exists.rows.length > 0) {
      return res.status(400).json({
        success: false,
        code: "USER_EXISTS",
        message: "User already exists"
      });
    }

    // 🔍 Check temp users
    const temp = await pool.query(
      "SELECT * FROM temp_users WHERE email=$1",
      [email]
    );

    // 🔐 hash password
    const hash = await bcrypt.hash(password, 10);

    // 🔢 OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    if (temp.rows.length > 0) {
      // 🔁 UPDATE existing temp user
      await pool.query(
        "UPDATE temp_users SET password=$1, otp=$2, otp_expiry=$3, otp_attempts=0 WHERE email=$4",
        [hash, otp, expiry, email]
      );
    } else {
      // 🆕 INSERT new temp user
      await pool.query(
        "INSERT INTO temp_users (email, password, otp, otp_expiry, otp_attempts) VALUES ($1,$2,$3,$4,0)",
        [email, hash, otp, expiry]
      );
    }

    // 📧 Send OTP
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      to: email,
      subject: "OTP Verification",
      html: `<h2>Your OTP: ${otp}</h2>`
    });

    res.json({
      success: true,
      message: "OTP sent to email"
    });

  } catch (err) {
    console.error("❌ Signup error:", err.message);
    res.status(500).json({
      success: false,
      code: "SIGNUP_FAILED",
      message: "Signup failed"
    });
  }
});


//==============verify otp========================
app.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;

  try {
    const tempUser = await pool.query(
      "SELECT * FROM temp_users WHERE email=$1",
      [email]
    );

    if (tempUser.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found"
      });
    }

    const user = tempUser.rows[0];

    // ⏳ Expiry check
    if (new Date(user.otp_expiry) < new Date()) {
      return res.status(400).json({
        success: false,
        code: "OTP_EXPIRED",
        message: "OTP expired"
      });
    }

    // 🔒 Block AFTER checking resend case
    if (user.otp_attempts >= 5) {
      return res.status(403).json({
        success: false,
        code: "OTP_LIMIT_EXCEEDED",
        message: "Too many attempts. Please resend OTP"
      });
    }

    // ✅ Correct OTP
    if (user.otp === otp) {
      await pool.query(
        "INSERT INTO users (email, password, is_verified) VALUES ($1,$2,true)",
        [user.email, user.password]
      );

      await pool.query(
        "DELETE FROM temp_users WHERE email=$1",
        [email]
      );

      return res.json({
        success: true,
        message: "Account created ✅"
      });
    }

    // ❌ Wrong OTP → increase attempts
    await pool.query(
      "UPDATE temp_users SET otp_attempts = otp_attempts + 1 WHERE email=$1",
      [email]
    );

    return res.status(400).json({
      success: false,
      code: "INVALID_OTP",
      message: "Invalid OTP"
    });

  } catch (err) {
    console.error("❌ OTP verification error:", err.message);
    res.status(500).json({
      success: false,
      code: "OTP_VERIFICATION_FAILED",
      message: "Verification failed"
    });
  }
});
//=================resend otp========================
app.post("/resend-otp", async (req, res) => {
  const { email } = req.body;

  try {
    const user = await pool.query(
      "SELECT * FROM temp_users WHERE email=$1",
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: "NO_PENDING_VERIFICATION",
        message: "No pending verification"
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    // ✅ UPDATE (not INSERT)
    await pool.query(
      `UPDATE temp_users 
       SET otp=$1, otp_expiry=$2, otp_attempts=0
       WHERE email=$3`,
      [otp, expiry, email]
    );

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      to: email,
      subject: "Resent OTP",
      html: `<h2>Your OTP: ${otp}</h2>`
    });

    res.json({
      success: true,
      message: "OTP resent"
    });

  } catch (err) {
    console.error("❌ Resend OTP error:", err.message);
    res.status(500).json({
      success: false,
      code: "RESEND_OTP_FAILED",
      message: "Failed to resend OTP"
    });
  }
});

//====================check result========================

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
        success: false,
        code: "NOT_SUBSCRIBED",
        message: "Please subscribe to check results"
      });
    }

    if (new Date(user.subscription_end) < new Date()) {
      return res.status(403).json({
        success: false,
        code: "SUBSCRIPTION_EXPIRED",
        message: "Subscription expired",
        expiry: user.subscription_end
      });
    }

    // ✅ get latest draw
    const draw = await pool.query(`
      SELECT * FROM draws
      ORDER BY created_at DESC
       LIMIT 1
    `);

    if (draw.rows.length === 0) {
      return res.json({
        success: true,
        result: "No draw yet"
      });
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
      success: true,
      result: resultText,
      matches: matchCount,
      numbers: drawNumber,
      created_at: drawDate
    });

  } catch (err) {
    console.error("❌ Result error:", err.message);
    res.status(500).json({
      success: false,
      code: "RESULT_FAILED",
      message: "Failed to fetch result"
    });
  }
});

app.post("/approve-winning", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { winning_id } = req.body;

    console.log("🔥 Approve clicked:", winning_id);

    // ✅ Step 1: Get winning
    const win = await pool.query(
      "SELECT * FROM winnings WHERE id=$1",
      [winning_id]
    );

    if (win.rows.length === 0) {
      return res.status(403).json({
        success: false,
        code: "UNAUTHORIZED",
        message: "Not allowed"
      });
    }

    if (win.rows[0].status !== "pending") {
      return res.status(400).json({
        success: false,
        code: "ALREADY_PROCESSED",
        message: "Already processed"
      });
    }

    const userId = win.rows[0].user_id;
    const amount = Number(win.rows[0].amount);

    console.log("User:", userId, "Amount:", amount);

    // ✅ Step 2: Update status
    await pool.query(
      "UPDATE winnings SET status = 'paid' WHERE id = $1",
      [winning_id]
    );

    // ✅ Step 3: Charity calculation
    const charityAmount = amount * 0.1;

    // 🔥 NEW: Get user's selected charity
    const userCharity = await pool.query(
      `SELECT c.name 
       FROM users u
       LEFT JOIN charities c ON u.charity_id = c.id
       WHERE u.id = $1`,
      [userId]
    );

    const charityName =
      userCharity.rows[0]?.name || "Helping Hands"; // fallback

    console.log("Charity:", charityName);

    // ✅ Step 4: Insert donation
    await pool.query(
      `INSERT INTO charity_donations 
       (user_id, amount, charity_name, winning_id)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        charityAmount,
        charityName,   // ✅ dynamic now
        winning_id
      ]
    );

    console.log("✅ Charity inserted");

    res.json({
      success: true,
      message: "Approved + Charity Added ✅"
    });

  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    res.status(500).json({
      success: false,
      code: "APPROVAL_FAILED",
      message: "Failed to approve winning"
    });
  }
});

app.get("/all-winnings", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        w.id,
        u.email,
        w.amount,
        w.status,
        w.proof,
        w.match_type,
        d.created_at AS draw_date
      FROM winnings w
      JOIN users u ON u.id = w.user_id
      JOIN draws d ON d.id = w.draw_id
      ORDER BY d.created_at DESC
    `);
    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error("❌ Winnings fetch error:", err.message);
    res.status(500).json({
      success: false,
      code: "WINNINGS_FETCH_FAILED",
      message: "Fetch failed"
    });
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
      return res.status(400).json({
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found"
      });

    }

    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({
        success: false,
        code: "INVALID_PASSWORD",
        message: "Wrong password"
      });
    }

    if (!user.is_verified) {
      return res.status(403).json({
        success: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email first"
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role || "user"
      },
      process.env.JWT_SECRET || "secret123",
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role || "user"
      }
    });

  } catch (err) {
    console.error(" Login error:", err.message);
    res.status(500).json({
      success: false,
      code: "LOGIN_FAILED",
      message: "Login failed"
    });
  }
});
//=================forgot password========================

//const crypto = require("crypto");
//const nodemailer = require("nodemailer");

app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    const user = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found"
      });

    }

    // 🔐 generate token
    const token = crypto.randomBytes(32).toString("hex");

    // ⏳ expiry (1 hour)
    const expiry = new Date(Date.now() + 3600000);

    // 💾 store in DB
    await pool.query(
      "UPDATE users SET reset_token=$1, reset_token_expiry=$2 WHERE email=$3",
      [token, expiry, email]
    );

    // 📧 send email
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    //const resetLink = `http://localhost:5173/reset-password/${token}`;
    const resetLink = `https://golf-frontend-mu.vercel.app/reset-password/${token}`;

    await transporter.sendMail({
      to: email,
      subject: "Password Reset",
      html: `
        <h3>Password Reset</h3>
        <p>Click below to reset your password:</p>
        <a href="${resetLink}">${resetLink}</a>
      `
    });

    res.json({ success: true, message: "Reset link sent" });

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Something went wrong"
    });
  }
});
//=====================reset password========================
app.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    const user = await pool.query(
      "SELECT * FROM users WHERE reset_token=$1 AND reset_token_expiry > NOW()",
      [token]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token"
      });
    }

    //const bcrypt = require("bcrypt");
    const hashed = await bcrypt.hash(password, 10);

    await pool.query(
      "UPDATE users SET password=$1, reset_token=NULL, reset_token_expiry=NULL WHERE id=$2",
      [hashed, user.rows[0].id]
    );

    res.json({ success: true, message: "Password updated" });

  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Something went wrong"
    });
  }
});

// ================== USERS ==================
app.get("/users", async (req, res) => {
  const result = await pool.query("SELECT id,email FROM users");
  res.json({
    success: true,
    data: result.rows
  });
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
        success: false,
        code: "NOT_SUBSCRIBED",
        message: "Please subscribe first"
      });
    }
    if (new Date(end) < new Date()) {
      const formattedDate = new Date(end).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      });

      return res.status(403).json({
        success: false,
        code: "SUBSCRIPTION_EXPIRED",
        message: `Subscription expired on ${formattedDate}`,
        expiry: end
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
        success: false,
        code: "DRAW_CLOSED",
        message: "Score entry closed for this month"
      });
    }

    // ✅ VALIDATION


    if (score < 1 || score > 45) {
      return res.status(400).json({
        success: false,
        code: "INVALID_SCORE",
        message: "Score must be between 1 and 45"
      });
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


    console.log("🔥 STEP 3 - JACKPOT UPDATED");

    // ✅ KEEP ONLY LAST 5
    // await pool.query(`
    //   DELETE FROM scores
    //   WHERE id NOT IN (
    //     SELECT id FROM scores
    //     WHERE user_id=$1
    //     ORDER BY created_at DESC
    //     LIMIT 5
    //   ) AND user_id=$1
    // `, [user_id]);

    res.json({
      success: true,
      message: "Score added successfully"
    });

  } catch (err) {
    console.error("❌ Score error:", err.message);
    res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Something went wrong"
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
      LIMIT 10
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ Scores fetch error:", err.message);
    res.status(500).json({
      success: false,
      code: "SCORES_FETCH_FAILED",
      message: "Error fetching scores"
    });
  }
});

// ================== DASHBOARD ==================
app.get("/dashboard", verifyToken, async (req, res) => {
  try {
    const id = req.user.id;
    console.log("Dashboard API called:", id);

    const user = await pool.query(`
  SELECT 
    u.id,
    u.email,
    u.charity_id,
    u.subscription_status,
    u.subscription_type,
    u.subscription_end,
    c.name AS charity_name
  FROM users u
  LEFT JOIN charities c ON u.charity_id = c.id
  WHERE u.id = $1
`, [id]);

    if (user.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found"
      });
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
      success: true,
      user: user.rows[0],
      scores: scores.rows,
      winnings: winnings.rows
    });

  } catch (err) {
    console.error("❌ Dashboard error:", err.message);
    res.status(500).json({
      success: false,
      code: "DASHBOARD_FAILED",
      message: "Dashboard error"
    });
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

    if (!razorpay_payment_id || !type) {
      return res.status(400).json({
        success: false,
        code: "MISSING_PAYMENT_DATA",
        message: "Missing payment data"
      });
    }

    // signature verification
    if (razorpay_order_id && razorpay_signature) {
      const generatedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({
          success: false,
          code: "INVALID_SIGNATURE",
          message: "Invalid payment signature"
        });
      }
    }

    // plan pricing
    let interval = "30 days";
    let amount = 100;

    if (type === "yearly") {
      interval = "365 days";
      amount = 1000;   //changed from 1200 → 1000
    }

    // update subscription
    const result = await pool.query(
      `UPDATE users 
       SET subscription_status='active',
           subscription_type=$2,
           subscription_start=NOW(),
           subscription_end=NOW() + INTERVAL '${interval}'
       WHERE id=$1
       RETURNING *`,
      [user_id, type]
    );

    // 🔥 STORE PAYMENT HISTORY
    await pool.query(
      `INSERT INTO payments 
       (user_id, amount, subscription_type, payment_id)
       VALUES ($1,$2,$3,$4)`,
      [
        user_id,
        amount,
        type,
        razorpay_payment_id
      ]
    );

    res.json({
      success: true,
      message: "Payment verified",
      data: result.rows[0]
    });

  } catch (err) {
    console.error(" Verify payment error:", err.message);

    res.status(500).json({
      success: false,
      message: "Verification failed"
    });
  }
});


// ========donate to charity========
app.post("/donate-charity", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;

    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      charity_name,
      amount
    } = req.body;

    if (!charity_name || !amount) {
      return res.status(400).json({
        success: false,
        message: "Charity name and amount required"
      });
    }

    // signature verification
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(
        razorpay_order_id + "|" + razorpay_payment_id
      )
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature"
      });
    }

    // store donation
    await pool.query(
      `INSERT INTO charity_donations
      (user_id, amount, charity_name, winning_id)
      VALUES ($1,$2,$3,$4)`,
      [
        user_id,
        amount,
        charity_name,
        null   // direct donation
      ]
    );

    res.json({
      success: true,
      message: "Donation successful ❤️"
    });

  } catch (err) {
    console.error("DONATION ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Donation failed"
    });
  }
});


//====================check subscription=========================
app.post("/activate-subscription", verifyToken, async (req, res) => {
  try {
    const user_id = req.user.id;

    const result = await pool.query(
      `UPDATE users 
       SET subscription_status='active',
           subscription_end = NOW() + INTERVAL '30 days'
       WHERE id=$1
       RETURNING *`,
      [user_id]
    );

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (err) {
    console.error(" Activate subscription error:", err.message);
    res.status(500).json({
      success: false,
      code: "SUBSCRIPTION_ACTIVATION_FAILED",
      message: "Activation failed"
    });
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
      return res.status(404).json({
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found"
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      code: user.real_status === "active" ? "ACTIVE" : "INACTIVE",
      status: user.real_status,
      subscription_type: user.subscription_type,
      subscription_end: user.subscription_end
    });

  } catch (err) {
    console.error("❌ Check subscription error:", err.message);
    res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Something went wrong"
    });
  }
});

// ================== LEADERBOARD ==================
app.get("/leaderboard", async (req, res) => {
  const result = await pool.query(`
  SELECT u.email, MAX(s.score) AS best_score
  FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
    FROM scores
  ) s
  JOIN users u ON u.id = s.user_id
  WHERE s.rn <= 5
  GROUP BY u.id, u.email
  ORDER BY best_score DESC
  LIMIT 5;
`);

  res.json({
    success: true,
    data: result.rows
  });
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
      success: true,
      jackpot: result.rows[0]?.amount || 0,
      basePool // 🔥 THIS WAS MISSING
    });

  } catch (err) {
    console.error("❌ Jackpot error:", err.message);
    res.status(500).json({
      success: false,
      code: "JACKPOT_FETCH_FAILED",
      message: "Failed to fetch jackpot"
    });
  }
});



//===================reject button===========
app.post("/reject-winning", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { winning_id } = req.body;

    await pool.query(
      "UPDATE winnings SET status='rejected' WHERE id=$1",
      [winning_id]
    );

    res.json({
      success: true,
      message: "Rejected ❌"
    });

  } catch (err) {
    console.error("❌ Reject error:", err.message);
    res.status(500).json({
      success: false,
      code: "REJECT_FAILED",
      message: "Failed to reject winning"
    });
  }
});


// ================= SIMULATE DRAW =================
app.post("/simulate-draw", verifyToken, verifyAdmin, async (req, res) => {
  try {
    // 🔥 1️⃣ Get ONLY ACTIVE (subscribed) users
    const drawDate = req.body.drawDate || new Date();

    const usersRes = await pool.query(`
  SELECT id, email
  FROM users
  WHERE subscription_start <= $1
  AND subscription_end >= $1
`, [drawDate]);

    const users = usersRes.rows;

    if (users.length === 0) {
      return res.json({
        success: true,
        numbers: [],
        results: [],
        message: "No active users"
      });
    }

    // 📊 2️⃣ Get all scores (latest first)
    const scoresRes = await pool.query(`
            SELECT * FROM (
          SELECT *,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
          FROM scores
        ) t
        WHERE rn <= 5;
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
        success: true,
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
      success: true,
      numbers,
      results,
      basePool,
      jackpot: previousJackpot,
      totalPool: poolAmount
    });

  } catch (err) {
    console.error("❌ Simulation error:", err.message);
    res.status(500).json({
      success: false,
      code: "SIMULATION_FAILED",
      message: "Simulation failed"
    })
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

    res.json({
      success: true,
      data: order
    });
  } catch (err) {
    console.error("ORDER ERROR:", err);
    res.status(500).json({
      success: false,
      code: "ORDER_FAILED",
      message: "Order creation failed"
    });
  }
});
//==============admin stats============

app.get("/admin-stats", async (req, res) => {
  try {
    const users = await pool.query("SELECT COUNT(*) FROM users");

    const paid = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS total 
      FROM winnings 
      WHERE status='paid'
    `);

    const pending = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS total 
      FROM winnings 
      WHERE status='pending'
    `);

    const totalWinnings = await pool.query(
      "SELECT COUNT(*) FROM winnings"
    );

    const charity = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS total 
      FROM charity_donations
    `);

    res.json({
      success: true,
      users: users.rows[0].count,
      paid: paid.rows[0].total,
      pending: pending.rows[0].total,
      totalWinnings: totalWinnings.rows[0].count,
      totalCharity: charity.rows[0].total
    });

  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Something went wrong"
    });
  }
});

//==================admin-analytics=============
app.get("/admin-analytics", async (req, res) => {
  try {

    // total earnings from actual payments
    const earnings = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS total
      FROM payments
    `);

    const totalEarnings = Number(earnings.rows[0].total) || 0;

    // total paid winnings
    const paid = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS total
      FROM winnings
      WHERE status='paid'
    `);

    const totalPaid = Number(paid.rows[0].total) || 0;

    // pending winnings
    const pending = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS total
      FROM winnings
      WHERE status='pending'
    `);

    const totalPending = Number(pending.rows[0].total) || 0;

    // monthly analytics
    const monthly = await pool.query(`
      WITH monthly_payments AS (
        SELECT
          DATE_TRUNC('month', created_at) AS month,
          SUM(amount) AS total_pool
        FROM payments
        GROUP BY month
      ),

      monthly_paid AS (
        SELECT
          DATE_TRUNC('month', created_at) AS month,
          SUM(amount) AS paid
        FROM winnings
        WHERE status='paid'
        GROUP BY month
      )

      SELECT
        TO_CHAR(COALESCE(mp.month, mw.month), 'Mon YYYY') AS name,
        COALESCE(mp.total_pool,0) AS total_pool,
        COALESCE(mw.paid,0) AS paid,

        (
          COALESCE(mp.total_pool,0)
          - COALESCE(mw.paid,0)
          - (COALESCE(mp.total_pool,0) * 0.4)
        ) AS revenue

      FROM monthly_payments mp
      FULL OUTER JOIN monthly_paid mw
      ON mp.month = mw.month

      ORDER BY COALESCE(mp.month, mw.month)
    `);

    const profit = monthly.rows.reduce((acc, item) =>
      acc + Number(item.revenue), 0
    );

    res.json({
      success: true,
      totalEarnings,
      totalPaid,
      totalPending,
      profit,
      monthly: monthly.rows
    });

  } catch (err) {
    console.error("❌ ADMIN ANALYTICS ERROR:", err.message);

    res.status(500).json({
      success: false,
      message: "Something went wrong"
    });
  }
});

// =============breakdown charity=====

app.get("/charity-breakdown", async (req, res) => {
  const result = await pool.query(`
    SELECT charity_name, SUM(amount) AS total
    FROM charity_donations
    GROUP BY charity_name
  `);

  res.json({
    success: true,
    data: result.rows
  });
});



// ================== DELETE CHARITY ==================
app.delete("/charities/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // 🔍 Check if any user is using this charity
    const check = await pool.query(
      "SELECT COUNT(*) FROM users WHERE charity_id = $1",
      [id]
    );

    const count = Number(check.rows[0].count);

    if (count > 0) {
      return res.status(400).json({
        success: false,
        code: "CHARITY_IN_USE",
        message: "Charity is in use by users ❌"
      });
    }

    // ✅ DELETE IMAGES FIRST (ADD THIS HERE)
    await pool.query(
      "DELETE FROM charity_images WHERE charity_id=$1",
      [id]
    );

    // ✅ THEN DELETE CHARITY
    await pool.query(
      "DELETE FROM charities WHERE id = $1",
      [id]
    );

    res.json({
      success: true,
      message: "Charity deleted ✅"
    });

  } catch (err) {
    console.error("❌ Delete charity error:", err.message);
    res.status(500).json({
      success: false,
      message: "Delete failed"
    });
  }
});


// =======Edit charity========
// app.put(
//   "/charities/:id",
//   verifyToken,
//   verifyAdmin,
//   upload.array("images", 5),
//   async (req, res) => {
//     try {
//       const { id } = req.params;
//       const { name, description } = req.body;

//       // ✅ update text
//       await pool.query(
//         "UPDATE charities SET name=$1, description=$2 WHERE id=$3",
//         [name, description, id]
//       );

//       // ✅ ONLY ADD new images (DON'T DELETE OLD)
//       if (req.files && req.files.length > 0) {
//         for (let file of req.files) {
//           const path = file.path;

//           await pool.query(
//             "INSERT INTO charity_images (charity_id, image) VALUES ($1,$2)",
//             [id, path]
//           );
//         }
//       }

//       res.json({
//         success: true,
//         message: "Charity updated ✅"
//       });

//     } catch (err) {
//       console.error("❌ Update charity error:", err.message);
//       res.status(500).json({
//         success: false,
//         message: "Update failed"
//       });
//     }
//   }
// );

app.put(
  "/charities/:id",
  verifyToken,
  verifyAdmin,
  upload.array("images", 5),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Name is required"
        });
      }

      await pool.query(
        "UPDATE charities SET name=$1, description=$2 WHERE id=$3",
        [name, description, id]
      );

      if (req.files && req.files.length > 0) {
        for (let file of req.files) {
          if (!file.path) {
            console.error("❌ Missing file path:", file);
            continue;
          }

          await pool.query(
            "INSERT INTO charity_images (charity_id, image) VALUES ($1,$2)",
            [id, file.path]
          );
        }
      }

      res.json({
        success: true,
        message: "Charity updated ✅"
      });

    } catch (err) {
      console.error("❌ Update charity error FULL:", err);
      res.status(500).json({
        success: false,
        message: "Update failed"
      });
    }
  }
);


//=========delete charity image========
app.delete("/charity-image", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Image id required"
      });
    }

    // 🔥 1. Get image URL from DB
    const result = await pool.query(
      "SELECT image FROM charity_images WHERE id=$1",
      [id]
    );

    const imageUrl = result.rows[0]?.image;

    // 🔥 2. Delete from Cloudinary
    if (imageUrl) {
      const parts = imageUrl.split("/");
      const fileName = parts[parts.length - 1]; // abc123.jpg
      const publicId = "charities/" + fileName.split(".")[0];

      await cloudinary.uploader.destroy(publicId);
    }

    // 🔥 3. Delete from DB
    await pool.query(
      "DELETE FROM charity_images WHERE id=$1",
      [id]
    );

    res.json({
      success: true,
      message: "Image deleted from Cloudinary + DB ✅"
    });

  } catch (err) {
    console.error("❌ Delete charity image error:", err.message);
    res.status(500).json({
      success: false,
      message: "Delete failed"
    });
  }
});
// ================== SERVER ==================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
