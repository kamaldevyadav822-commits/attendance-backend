// ===============================
// IMPORTS & BASIC SETUP
// ===============================
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("./attendance.db");

// ===============================
// DATABASE TABLES
// ===============================
db.serialize(() => {

  // ---------- STUDENTS ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      roll_no TEXT UNIQUE NOT NULL,
      department TEXT NOT NULL
    )
  `);

  // ---------- TEACHERS ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS teachers (
      teacher_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  // ---------- ATTENDANCE SESSIONS ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      session_id TEXT PRIMARY KEY,
      department TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      status TEXT
    )
  `);

  // ---------- ATTENDANCE RECORDS ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      session_id TEXT,
      student_id TEXT,
      status TEXT,
      UNIQUE(session_id, student_id)
    )
  `);
});

// ===============================
// CREATE DEFAULT TEACHER (ONCE)
// ===============================
db.get("SELECT * FROM teachers", (err, row) => {
  if (!row) {
    db.run(
      "INSERT INTO teachers VALUES (?, ?, ?)",
      ["t-001", "admin", "admin123"]
    );
    console.log("Default teacher created → username: admin | password: admin123");
  }
});

// ===============================
// STUDENT REGISTRATION
// ===============================
app.post("/api/students/register", (req, res) => {
  const { name, roll_no, department } = req.body;

  if (!name || !roll_no || !department) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const student_id = uuidv4();

  db.run(
    "INSERT INTO students VALUES (?, ?, ?, ?)",
    [student_id, name, roll_no, department],
    err => {
      if (err) {
        return res.status(400).json({ error: "Roll number already exists" });
      }
      res.json({ student_id });
    }
  );
});

// ===============================
// TEACHER LOGIN
// ===============================
app.post("/api/teacher/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  db.get(
    "SELECT teacher_id FROM teachers WHERE username=? AND password=?",
    [username, password],
    (err, row) => {
      if (!row) {
        return res.status(401).json({ error: "Invalid username or password" });
      }
      res.json({ teacher_id: row.teacher_id });
    }
  );
});

// ===============================
// START ATTENDANCE SESSION (TEACHER ONLY)
// ===============================
app.post("/api/sessions/start", (req, res) => {
  const { teacher_id, department, duration_minutes } = req.body;

  if (!teacher_id || !department || !duration_minutes) {
    return res.status(403).json({ error: "Unauthorized or missing fields" });
  }

  const now = Date.now();

  // verify teacher
  db.get(
    "SELECT * FROM teachers WHERE teacher_id=?",
    [teacher_id],
    (err, teacher) => {
      if (!teacher) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // only one active session per department
      db.get(
        "SELECT * FROM attendance_sessions WHERE status='ACTIVE' AND department=?",
        [department],
        (err, existing) => {
          if (existing) {
            return res.status(400).json({ error: "Session already active" });
          }

          const session_id = uuidv4();
          db.run(
            "INSERT INTO attendance_sessions VALUES (?, ?, ?, ?, 'ACTIVE')",
            [session_id, department, now, now + duration_minutes * 60000],
            () => res.json({ session_id })
          );
        }
      );
    }
  );
});

// ===============================
// MARK ATTENDANCE (STUDENT)
// ===============================
app.post("/api/attendance/mark", (req, res) => {
  const { student_id } = req.body;
  const now = Date.now();

  if (!student_id) {
    return res.status(400).json({ error: "Student ID missing" });
  }

  db.get(
    `
    SELECT s.session_id
    FROM attendance_sessions s
    JOIN students st ON s.department = st.department
    WHERE s.status='ACTIVE'
      AND s.end_time > ?
      AND st.student_id = ?
    `,
    [now, student_id],
    (err, session) => {
      if (!session) {
        return res.status(400).json({ error: "Attendance closed or invalid" });
      }

      db.run(
        "INSERT INTO attendance_records VALUES (?, ?, 'PRESENT')",
        [session.session_id, student_id],
        err => {
          if (err) {
            return res.status(400).json({ error: "Already marked" });
          }
          res.json({ message: "Attendance marked successfully" });
        }
      );
    }
  );
});

// ===============================
// AUTO END SESSION & MARK ABSENT
// ===============================
setInterval(() => {
  const now = Date.now();

  db.all(
    "SELECT * FROM attendance_sessions WHERE status='ACTIVE' AND end_time <= ?",
    [now],
    (err, sessions) => {
      sessions.forEach(s => {

        // mark absentees
        db.run(
          `
          INSERT OR IGNORE INTO attendance_records
          SELECT ?, student_id, 'ABSENT'
          FROM students WHERE department=?
          `,
          [s.session_id, s.department]
        );

        // close session
        db.run(
          "UPDATE attendance_sessions SET status='INACTIVE' WHERE session_id=?",
          [s.session_id]
        );
      });
    }
  );
}, 60000);

// ===============================
// ATTENDANCE HISTORY (DATE-WISE, TEACHER)
// ===============================
app.get("/api/admin/history", (req, res) => {
  const { teacher_id, department, date } = req.query;

  if (!teacher_id || !department || !date) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const dayStart = new Date(date).setHours(0, 0, 0, 0);
  const dayEnd = new Date(date).setHours(23, 59, 59, 999);

  db.get(
    "SELECT * FROM teachers WHERE teacher_id=?",
    [teacher_id],
    (err, teacher) => {
      if (!teacher) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      db.all(
        `
        SELECT st.name, st.roll_no, ar.status
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.session_id
        JOIN students st ON ar.student_id = st.student_id
        WHERE s.department = ?
          AND s.start_time BETWEEN ? AND ?
        `,
        [department, dayStart, dayEnd],
        (err, rows) => res.json(rows)
      );
    }
  );
});

// ===============================
// QR GENERATION (TEACHER PANEL)
// ===============================
app.get("/api/admin/qr", (req, res) => {
  const { teacher_id } = req.query;

  if (!teacher_id) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  db.get(
    "SELECT * FROM teachers WHERE teacher_id=?",
    [teacher_id],
    (err, teacher) => {
      if (!teacher) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // 🔴 CHANGE THIS TO YOUR STUDENT APP URL
      res.json({
        qr_url: "https://attendance-frontendd.onrender.com/"
      });
    }
  );
});

// ===============================
// SERVER START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
