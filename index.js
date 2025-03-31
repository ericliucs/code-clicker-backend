require("dotenv").config();
const express = require("express");
const app = express();
// const DB_PORT = process.env.DB_PORT;
const PORT = process.env.PORT || 3001;
const app_port = 3001;
const bcrypt = require("bcryptjs");
const saltRounds = 10;
const jsonWebToken = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");

// Update CORS to allow requests from GitHub Pages
app.use(cors({
  origin: ['https://ericliucs.github.io', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../build')));

const { Pool } = require("pg");
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }
    : {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT,
      }
);

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) return res.sendStatus(401);

  jsonWebToken.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

app.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT 'Connected to Code Clicker API!' as msg"
    );
    res.send(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: err.toString() });
  }
});

app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Check if username already taken
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: "Username already taken" });
    }

    const passwordHash = await bcrypt.hash(password, saltRounds);

    const result = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, passwordHash]
    );

    await pool.query(
      "INSERT INTO game_saves (user_id, loc, loc_per_second, loc_per_click, upgrades) VALUES ($1, $2, $3, $4, $5)",
      [result.rows[0].id, 0, 0, 1, JSON.stringify({})]
    );

    const token = jsonWebToken.sign(
      { id: result.rows[0].id, username: result.rows[0].username },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({
      message: "User created successfully",
      user: {
        id: result.rows[0].id,
        username: result.rows[0].username,
      },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = result.rows[0];

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = jsonWebToken.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      message: "Login successful",
      user: { id: user.id, username: user.username },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error during login" });
  }
});

app.post("/save", authenticateToken, async (req, res) => {
  const { loc, locPerSecond, locPerClick, upgrades } = req.body;
  const userId = req.user.id;

  try {
    await pool.query(
      `UPDATE game_saves SET 
        loc = $1, 
        loc_per_second = $2, 
        loc_per_click = $3, 
        upgrades = $4, 
        last_updated = NOW() 
      WHERE user_id = $5`,
      [loc, locPerSecond, locPerClick, JSON.stringify(upgrades), userId]
    );

    await pool.query(
      `INSERT INTO leaderboard (user_id, total_loc, loc_per_second, last_updated)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         total_loc = $2, 
         loc_per_second = $3, 
         last_updated = NOW()`,
      [userId, loc, locPerSecond]
    );

    res.json({ message: "Game progress saved successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while saving game" });
  }
});

app.get("/load", authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      "SELECT * FROM game_saves WHERE user_id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      // TODO: Maybe just deny the save instead?
      // No save found, create a new one with default values
      await pool.query(
        "INSERT INTO game_saves (user_id, loc, loc_per_second, loc_per_click, upgrades) VALUES ($1, $2, $3, $4, $5)",
        [userId, 0, 0, 1, JSON.stringify([])]
      );

      const savedGame = result.rows[0];
      const upgrades = JSON.parse(savedGame.upgrades);

      return res.json({
        loc: "0",
        locPerSecond: "0",
        locPerClick: "1",
        upgrades: upgrades,
      });
    }

    const savedGame = result.rows[0];

    res.json({
      loc: savedGame.loc.toString(),
      locPerSecond: savedGame.loc_per_second.toString(),
      locPerClick: savedGame.loc_per_click.toString(),
      upgrades: savedGame.upgrades,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while loading game" });
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.username, l.total_loc, l.loc_per_second, l.last_updated
       FROM leaderboard l
       JOIN users u ON l.user_id = u.id
       ORDER BY l.total_loc DESC
       LIMIT 50`
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while fetching leaderboard" });
  }
});


