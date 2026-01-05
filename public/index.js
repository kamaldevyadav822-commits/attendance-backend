const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("./attendance.db");

// ---------- DATABASE ----------
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      name TEXT,
      roll_no TEXT UNIQUE,
      department TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      session_id TEXT PRIMARY KEY,
      department TEXT,
      start_time INTEGER,
      end_time INTEGER,
      status TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      session_id TEXT,
      student_id TEXT,
      status TEXT,
      UNIQUE(session_id, student_id)
    )
  `);
});

// ---------- REGISTER STUDENT ----------
app.post("/api/students/register", (req, res) => {
  const { name, roll_no, department } = req.body;
  if (!name || !roll_no || !department) {
    return res.status(400).json({ error: "All fields required" });
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

// ---------- START SESSION (UNPROTECTED FOR NOW) ----------
app.post("/api/sessions/start", (req, res) => {
  const { department, duration_minutes } = req.body;
  const now = Date.now();

  db.get(
    "SELECT * FROM attendance_sessions WHERE status='ACTIVE' AND department=?",
    [department],
    (err, row) => {
      if (row) {
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
});

// ---------- MARK ATTENDANCE ----------
app.post("/api/attendance/mark", (req, res) => {
  const { student_id } = req.body;
  const now = Date.now();

  db.get(
    `
    SELECT s.session_id
    FROM attendance_sessions s
    JOIN students st
      ON s.department = st.department
    WHERE s.status='ACTIVE'
      AND s.end_time > ?
      AND st.student_id = ?
    `,
    [now, student_id],
    (err, session) => {
      if (!session) {
        return res.status(400).json({ error: "Attendance closed" });
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

// ---------- AUTO END SESSION ----------
setInterval(() => {
  const now = Date.now();
  db.all(
    "SELECT * FROM attendance_sessions WHERE status='ACTIVE' AND end_time <= ?",
    [now],
    (err, sessions) => {
      sessions.forEach(s => {
        db.run(
          `
          INSERT OR IGNORE INTO attendance_records
          SELECT ?, student_id, 'ABSENT'
          FROM students WHERE department=?
          `,
          [s.session_id, s.department]
        );

        db.run(
          "UPDATE attendance_sessions SET status='INACTIVE' WHERE session_id=?",
          [s.session_id]
        );
      });
    }
  );
}, 60000);

// ---------- SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
