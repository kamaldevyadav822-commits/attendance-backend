// ================== IMPORTS ==================
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const bcrypt = require("bcrypt");

const app = express();
app.use(express.json());
app.use(cors());

// ================== DATABASE ==================
const db = new sqlite3.Database("./attendance.db");

// ================== TABLES ==================
db.serialize(() => {

  // STUDENTS
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      name TEXT,
      roll_no TEXT UNIQUE,
      department TEXT
    )
  `);

  // TEACHERS
  db.run(`
    CREATE TABLE IF NOT EXISTS teachers (
      teacher_id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  // SESSIONS
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      session_id TEXT PRIMARY KEY,
      department TEXT,
      start_time INTEGER,
      end_time INTEGER,
      status TEXT
    )
  `);

  // RECORDS
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      session_id TEXT,
      student_id TEXT,
      status TEXT,
      UNIQUE(session_id, student_id)
    )
  `);
});

// ================== DEFAULT TEACHER ==================
db.get("SELECT * FROM teachers", (err, row) => {
  if (!row) {
    const hash = bcrypt.hashSync("admin123", 10);
    db.run(
      "INSERT INTO teachers VALUES (?, ?, ?)",
      ["t-001", "admin", hash]
    );
    console.log("Default teacher created → admin / admin123");
  }
});

// ================== STUDENT REGISTER ==================
app.post("/api/students/register", (req, res) => {
  const { name, roll_no, department } = req.body;

  if (!name || !roll_no || !department) {
    return res.status(400).json({ error: "Missing fields" });
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

// ================== TEACHER LOGIN ==================
app.post("/api/teacher/login", (req, res) => {
  const { username, password } = req.body;

  db.get(
    "SELECT * FROM teachers WHERE username=?",
    [username],
    (err, teacher) => {
      if (!teacher || !bcrypt.compareSync(password, teacher.password)) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      res.json({ teacher_id: teacher.teacher_id });
    }
  );
});

// ================== START SESSION ==================
app.post("/api/sessions/start", (req, res) => {
  const { teacher_id, department, duration_minutes } = req.body;
  const now = Date.now();

  if (!teacher_id || !department || !duration_minutes) {
    return res.status(400).json({ error: "Invalid request" });
  }

  db.get(
    "SELECT * FROM teachers WHERE teacher_id=?",
    [teacher_id],
    (err, teacher) => {
      if (!teacher) return res.status(403).json({ error: "Unauthorized" });

      db.get(
        "SELECT * FROM attendance_sessions WHERE status='ACTIVE' AND department=?",
        [department],
        (err, active) => {
          if (active) {
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

// ================== MARK ATTENDANCE ==================
app.post("/api/attendance/mark", (req, res) => {
  const { student_id } = req.body;
  const now = Date.now();

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

// ================== AUTO CLOSE & ABSENT ==================
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

// ================== VIEW ATTENDANCE ==================
app.get("/api/admin/history", (req, res) => {
  const { teacher_id, department, date } = req.query;

  const start = new Date(date).setHours(0,0,0,0);
  const end = new Date(date).setHours(23,59,59,999);

  db.get(
    "SELECT * FROM teachers WHERE teacher_id=?",
    [teacher_id],
    (err, teacher) => {
      if (!teacher) return res.status(403).json({ error: "Unauthorized" });

      db.all(
        `
        SELECT st.name, st.roll_no, ar.status
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.session_id
        JOIN students st ON ar.student_id = st.student_id
        WHERE s.department=? AND s.start_time BETWEEN ? AND ?
        `,
        [department, start, end],
        (err, rows) => res.json(rows)
      );
    }
  );
});

// ================== EXPORT CSV ==================
app.get("/api/admin/export", (req, res) => {
  const { teacher_id, department, date } = req.query;

  const start = new Date(date).setHours(0,0,0,0);
  const end = new Date(date).setHours(23,59,59,999);

  db.all(
    `
    SELECT st.name, st.roll_no, ar.status
    FROM attendance_records ar
    JOIN attendance_sessions s ON ar.session_id = s.session_id
    JOIN students st ON ar.student_id = st.student_id
    WHERE s.department=? AND s.start_time BETWEEN ? AND ?
    `,
    [department, start, end],
    (err, rows) => {
      let csv = "Name,Roll No,Status\n";
      rows.forEach(r => {
        csv += `${r.name},${r.roll_no},${r.status}\n`;
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=attendance.csv");
      res.send(csv);
    }
  );
});

// ================== ADMIN: LIST STUDENTS ==================
app.get("/api/admin/students", (req, res) => {
  const { teacher_id } = req.query;

  db.get(
    "SELECT * FROM teachers WHERE teacher_id=?",
    [teacher_id],
    (err, teacher) => {
      if (!teacher) return res.status(403).json({ error: "Unauthorized" });

      db.all(
        "SELECT student_id, name, roll_no, department FROM students ORDER BY department, name",
        (err, rows) => res.json(rows)
      );
    }
  );
});

// ================== ADMIN: DELETE STUDENT ==================
app.delete("/api/admin/students/:id", (req, res) => {
  const { teacher_id } = req.query;
  const studentId = req.params.id;

  db.get(
    "SELECT * FROM teachers WHERE teacher_id=?",
    [teacher_id],
    (err, teacher) => {
      if (!teacher) return res.status(403).json({ error: "Unauthorized" });

      db.run(
        "DELETE FROM students WHERE student_id=?",
        [studentId],
        () => res.json({ message: "Student removed" })
      );
    }
  );
});

// ================== SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
