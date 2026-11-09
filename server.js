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

// توحيد وتنظيف رقم الهاتف للبحث المرن (دعم 079 و 96279)
function normalizePhone(phone) {
    let cleaned = phone.replace(/\D/g, ''); // إزالة أي رموز غير رقمية
    if (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1); // إزالة الصفر الأول 079 -> 79
    }
    if (cleaned.startsWith('962')) {
        cleaned = cleaned.substring(3); // إزالة 96279 -> 79
    }
    return cleaned;
}

// API البحث الشامل للأهالي (مع دعم مرن للخلوي بـ 079 أو 96279)
app.get('/api/search', (req, res) => {
    const rawQuery = req.query.query ? req.query.query.trim() : '';

    if (!rawQuery) {
        return res.status(400).json({ success: false, message: 'مطلوب إدخال رقم للبحث' });
    }

    const cleanPhone = normalizePhone(rawQuery);

    const sql = `
        SELECT s.*, t.id as teacher_id, t.name as teacher_name, t.subject, t.building, t.room, t.status as teacher_status
        FROM students s
        LEFT JOIN student_teachers st ON s.id = st.student_id
        LEFT JOIN teachers t ON st.teacher_id = t.id
        WHERE s.family_id = ? 
           OR s.national_id = ? 
           OR s.father_mobile = ? 
           OR s.mother_mobile = ?
           OR s.father_mobile LIKE ?
           OR s.mother_mobile LIKE ?
    `;

    const likeQuery = `%${cleanPhone}%`;

    db.all(sql, [rawQuery, rawQuery, rawQuery, rawQuery, likeQuery, likeQuery], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        if (!rows || rows.length === 0) {
            return res.json({ success: false, message: 'لم يتم العثور على سجلات' });
        }

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

        res.json({
            success: true,
            family: { family_id: familyId },
            students: Object.values(studentsMap)
        });
    });
});

app.listen(PORT, () => {
    console.log(`السيرفر يعمل على المنفذ: ${PORT}`);
});
