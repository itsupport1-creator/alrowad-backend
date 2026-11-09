const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// السماح الكامل بجميع طلبات CORS من النيتليفي وأي نطاق خارجي
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const dbPath = path.join(__dirname, 'school_event.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('خطأ الاتصال بقاعدة البيانات:', err.message);
    } else {
        console.log('تم الاتصال بقاعدة البيانات SQLite بنجاح.');
    }
});

function normalizePhone(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
    if (cleaned.startsWith('962')) cleaned = cleaned.substring(3);
    return cleaned;
}

// API البحث الشامل
app.get('/api/search', (req, res) => {
    const rawQuery = req.query.query ? req.query.query.trim() : '';
    if (!rawQuery) return res.status(400).json({ success: false, message: 'مطلوب رقم للبحث' });

    const cleanPhone = normalizePhone(rawQuery);
    const sql = `
        SELECT s.*, t.id as teacher_id, t.name as teacher_name, t.subject, t.building, t.room, t.status as teacher_status
        FROM students s
        LEFT JOIN student_teachers st ON s.id = st.student_id
        LEFT JOIN teachers t ON st.teacher_id = t.id
        WHERE s.family_id = ? OR s.national_id = ? OR s.father_mobile = ? OR s.mother_mobile = ?
           OR s.father_mobile LIKE ? OR s.mother_mobile LIKE ?
    `;
    const likeQuery = `%${cleanPhone}%`;

    db.all(sql, [rawQuery, rawQuery, rawQuery, rawQuery, likeQuery, likeQuery], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!rows || rows.length === 0) return res.json({ success: false, message: 'لم يتم العثور على سجلات' });

        const studentsMap = {};
        let familyId = rows[0].family_id || rawQuery;

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

        res.json({ success: true, family: { family_id: familyId }, students: Object.values(studentsMap) });
    });
});

// API حجز دور في قائمة الانتظار
app.post('/api/queue/join', (req, res) => {
    const { teacher_id, family_id, student_name } = req.body;
    if (!teacher_id || !family_id) {
        return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
    }

    // التحقق مما إذا كانت العائلة منتظرة بالأساس لدى هذا المعلم
    db.get('SELECT * FROM queues WHERE teacher_id = ? AND family_id = ? AND status = "waiting"', [teacher_id, family_id], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (row) {
            return res.json({ success: true, message: 'أنت مسجل في قائمة الانتظار بالفعل', queue_id: row.id });
        }

        db.run('INSERT INTO queues (teacher_id, family_id, student_name, status) VALUES (?, ?, ?, "waiting")',
            [teacher_id, family_id, student_name || ''],
            function(err2) {
                if (err2) return res.status(500).json({ success: false, error: err2.message });
                res.json({ success: true, message: 'تم حجز الدور بنجاح', queue_id: this.lastID });
            }
        );
    });
});

// API فحص حالة الدور والمنتظرين
app.get('/api/queue/status', (req, res) => {
    const { teacher_id, family_id } = req.query;
    if (!teacher_id) return res.status(400).json({ success: false, message: 'معرف المعلم مطلوب' });

    db.get('SELECT * FROM queues WHERE teacher_id = ? AND status = "serving"', [teacher_id], (err, servingRow) => {
        db.all('SELECT * FROM queues WHERE teacher_id = ? AND status = "waiting" ORDER BY id ASC', [teacher_id], (err2, waitingRows) => {
            let userPos = null;
            if (family_id && waitingRows) {
                const idx = waitingRows.findIndex(item => String(item.family_id) === String(family_id));
                if (idx !== -1) userPos = idx + 1;
            }

            res.json({
                success: true,
                serving: servingRow || null,
                waiting_count: waitingRows ? waitingRows.length : 0,
                waiting_list: waitingRows || [],
                user_position: userPos
            });
        });
    });
});

// API المعلم لاستدعاء التالي
app.post('/api/queue/next', (req, res) => {
    const { teacher_id, action } = req.body;
    if (!teacher_id) return res.status(400).json({ success: false, message: 'معرف المعلم مطلوب' });

    // إنهاء الشخص الحالي إن وجد
    db.run('UPDATE queues SET status = "completed", completed_at = CURRENT_TIMESTAMP WHERE teacher_id = ? AND status = "serving"', [teacher_id], () => {
        if (action === 'cancel') {
            return res.json({ success: true, message: 'تم الانتهاء' });
        }

        // استدعاء أول شخص في الانتظار
        db.get('SELECT * FROM queues WHERE teacher_id = ? AND status = "waiting" ORDER BY id ASC LIMIT 1', [teacher_id], (err, nextRow) => {
            if (!nextRow) return res.json({ success: true, message: 'لا يوجد منتظرون', serving: null });

            db.run('UPDATE queues SET status = "serving", started_at = CURRENT_TIMESTAMP WHERE id = ?', [nextRow.id], () => {
                res.json({ success: true, serving: nextRow });
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`السيرفر يعمل بنجاح على المنفذ: ${PORT}`);
});
