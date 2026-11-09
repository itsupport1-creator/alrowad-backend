const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'school_event.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
    } else {
        console.log('تم الاتصال بقاعدة البيانات SQLite بنجاح.');
    }
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            national_id TEXT,
            family_id TEXT,
            father_mobile TEXT,
            mother_mobile TEXT,
            student_name TEXT,
            grade TEXT,
            section TEXT,
            school TEXT,
            curriculum TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            subject TEXT,
            building TEXT,
            room TEXT,
            status TEXT DEFAULT 'available'
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS student_teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER,
            teacher_id INTEGER
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS queues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id TEXT NOT NULL,
            family_id TEXT NOT NULL,
            student_name TEXT,
            status TEXT DEFAULT 'waiting',
            started_at DATETIME,
            completed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// API جلب معلومات المعلم واسمه
app.get('/api/teacher/info', (req, res) => {
    const query = req.query.id ? req.query.id.trim() : '';
    if (!query) return res.status(400).json({ success: false, message: 'المعرف مطلوب' });

    db.get(
        `SELECT * FROM teachers WHERE id = ? OR name LIKE ?`,
        [query, `%${query}%`],
        (err, teacher) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (teacher) {
                res.json({ success: true, teacher: teacher });
            } else {
                res.json({ success: true, teacher: { id: query, name: `معلم رقم: ${query}` } });
            }
        }
    );
});

// API إحصائيات المعلم والتقرير الزمني
app.get('/api/teacher/report', (req, res) => {
    const { teacher_id } = req.query;
    if (!teacher_id) return res.status(400).json({ success: false, message: 'معرف المعلم مطلوب' });

    const sql = `
        SELECT *, 
        (julianday(completed_at) - julianday(started_at)) * 24 * 60 as duration_minutes
        FROM queues 
        WHERE (teacher_id = ? OR teacher_id = (SELECT name FROM teachers WHERE id = ?) OR teacher_id = (SELECT CAST(id AS TEXT) FROM teachers WHERE name = ?))
          AND status = 'completed'
    `;

    db.all(sql, [teacher_id, teacher_id, teacher_id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const completedCount = rows.length;
        let totalMinutes = 0;

        rows.forEach(r => {
            if (r.duration_minutes && r.duration_minutes > 0) {
                totalMinutes += r.duration_minutes;
            } else {
                totalMinutes += 3; // افتراضي 3 دقائق في حال عدم تسجيل البداية
            }
        });

        const avgMinutes = completedCount > 0 ? (totalMinutes / completedCount).toFixed(1) : 0;

        res.json({
            success: true,
            report: {
                completed_count: completedCount,
                total_minutes: Math.round(totalMinutes),
                avg_minutes_per_family: parseFloat(avgMinutes)
            }
        });
    });
});

// API البحث الشامل للأهالي
app.get('/api/search', (req, res) => {
    const query = req.query.query ? req.query.query.trim() : '';

    if (!query) {
        return res.status(400).json({ success: false, message: 'مطلوب إدخال رقم للبحث' });
    }

    const sql = `
        SELECT s.*, t.id as teacher_id, t.name as teacher_name, t.subject, t.building, t.room, t.status as teacher_status
        FROM students s
        LEFT JOIN student_teachers st ON s.id = st.student_id
        LEFT JOIN teachers t ON st.teacher_id = t.id
        WHERE s.family_id = ? 
           OR s.national_id = ? 
           OR s.father_mobile = ? 
           OR s.mother_mobile = ?
    `;

    db.all(sql, [query, query, query, query], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        if (!rows || rows.length === 0) {
            return res.json({ success: false, message: 'لم يتم العثور على سجلات' });
        }

        const studentsMap = {};
        let familyId = rows[0].family_id || query;

        rows.forEach(row => {
            if (!studentsMap[row.id]) {
                studentsMap[row.id] = {
                    id: row.id,
                    student_name: row.student_name,
                    grade: row.grade,
                    section: row.section,
                    school: row.school,
                    curriculum: row.curriculum,
                    teachers: []
                };
            }

            if (row.teacher_name) {
                studentsMap[row.id].teachers.push({
                    id: row.teacher_id,
                    name: row.teacher_name,
                    subject: row.subject,
                    building: row.building,
                    room: row.room,
                    status: row.teacher_status
                });
            }
        });

        res.json({
            success: true,
            family: { family_id: familyId },
            students: Object.values(studentsMap)
        });
    });
});

// API حجز دور (مع منع التكرار للمعلم نفسه)
app.post('/api/queue/join', (req, res) => {
    const { teacher_id, family_id, student_name } = req.body;
    
    if (!teacher_id || !family_id) {
        return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
    }

    // فحص ما إذا كانت العائلة قد حجزت أو زارت المعلم بالفعل
    db.get(
        `SELECT * FROM queues WHERE (teacher_id = ? OR teacher_id = (SELECT name FROM teachers WHERE id = ?)) AND family_id = ? AND status IN ('waiting', 'serving', 'completed')`,
        [teacher_id, teacher_id, family_id],
        (err, row) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            
            if (row) {
                if (row.status === 'completed') {
                    return res.json({ success: false, message: 'تمت زيارة هذا المعلم وإتمام المقابلة بنجاح لهذه العائلة لا يمكن الحجز مرة أخرى.' });
                }
                return res.json({ success: true, message: 'أنت مسجل بالفعل في قائمة الانتظار لهذا المعلم', queue_id: row.id });
            }

            db.run(
                `INSERT INTO queues (teacher_id, family_id, student_name) VALUES (?, ?, ?)`,
                [teacher_id, family_id, student_name || ''],
                function(err) {
                    if (err) return res.status(500).json({ success: false, error: err.message });
                    res.json({ success: true, queue_id: this.lastID, message: 'تم حجز الدور بنجاح' });
                }
            );
        }
    );
});

// API حالة الانتظار
app.get('/api/queue/status', (req, res) => {
    const { teacher_id, family_id } = req.query;

    if (!teacher_id) {
        return res.status(400).json({ success: false, message: 'معرف المعلم مطلوب' });
    }

    db.get(
        `SELECT * FROM queues WHERE (teacher_id = ? OR teacher_id = (SELECT name FROM teachers WHERE id = ?) OR teacher_id = (SELECT CAST(id AS TEXT) FROM teachers WHERE name = ?)) AND status = 'serving' ORDER BY id ASC LIMIT 1`,
        [teacher_id, teacher_id, teacher_id],
        (err, serving) => {
            if (err) return res.status(500).json({ success: false, error: err.message });

            db.all(
                `SELECT * FROM queues WHERE (teacher_id = ? OR teacher_id = (SELECT name FROM teachers WHERE id = ?) OR teacher_id = (SELECT CAST(id AS TEXT) FROM teachers WHERE name = ?)) AND status = 'waiting' ORDER BY id ASC`,
                [teacher_id, teacher_id, teacher_id],
                (err, waitingList) => {
                    if (err) return res.status(500).json({ success: false, error: err.message });

                    let userPosition = null;
                    if (family_id) {
                        const index = waitingList.findIndex(q => String(q.family_id) === String(family_id));
                        if (index !== -1) userPosition = index + 1;
                    }

                    res.json({
                        success: true,
                        serving: serving || null,
                        waiting_count: waitingList.length,
                        waiting_list: waitingList,
                        user_position: userPosition
                    });
                }
            );
        }
    );
});

// API استدعاء التالي وحساب الأوقات
app.post('/api/queue/next', (req, res) => {
    const { teacher_id, action } = req.body;

    if (!teacher_id) {
        return res.status(400).json({ success: false, message: 'معرف المعلم مطلوب' });
    }

    // إنهاء الدور الحالي وتسجيل الوقت
    db.run(
        `UPDATE queues SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE (teacher_id = ? OR teacher_id = (SELECT name FROM teachers WHERE id = ?) OR teacher_id = (SELECT CAST(id AS TEXT) FROM teachers WHERE name = ?)) AND status = 'serving'`,
        [teacher_id, teacher_id, teacher_id],
        (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });

            if (action === 'cancel') {
                db.run(`UPDATE queues SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM queues WHERE (teacher_id = ? OR teacher_id = (SELECT name FROM teachers WHERE id = ?) OR teacher_id = (SELECT CAST(id AS TEXT) FROM teachers WHERE name = ?)) AND status = 'waiting' ORDER BY id ASC LIMIT 1)`, [teacher_id, teacher_id, teacher_id]);
            }

            db.get(
                `SELECT id FROM queues WHERE (teacher_id = ? OR teacher_id = (SELECT name FROM teachers WHERE id = ?) OR teacher_id = (SELECT CAST(id AS TEXT) FROM teachers WHERE name = ?)) AND status = 'waiting' ORDER BY id ASC LIMIT 1`,
                [teacher_id, teacher_id, teacher_id],
                (err, nextPerson) => {
                    if (err) return res.status(500).json({ success: false, error: err.message });

                    if (!nextPerson) {
                        return res.json({ success: true, message: 'لا يوجد منتظرون', serving: null });
                    }

                    db.run(
                        `UPDATE queues SET status = 'serving', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [nextPerson.id],
                        (err) => {
                            if (err) return res.status(500).json({ success: false, error: err.message });
                            res.json({ success: true, message: 'تم استدعاء التالي' });
                        }
                    );
                }
            );
        }
    );
});

app.listen(PORT, () => {
    console.log(`السيرفر يعمل على المنفذ: ${PORT}`);
});
