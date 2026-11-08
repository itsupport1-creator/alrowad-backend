const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

const db = new sqlite3.Database(path.join(__dirname, 'school_event.db'));

function normalizeInput(input) {
    if (!input) return '';
    let str = input.toString().trim().replace(/\s+/g, '').replace('+', '');
    if (str.startsWith('07')) {
        str = '962' + str.substring(1);
    }
    return str;
}

app.get('/api/search', (req, res) => {
    const rawQuery = req.query.query;
    if (!rawQuery) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال قيمة للبحث' });
    }

    const searchValue = normalizeInput(rawQuery);
    const searchPattern = `%${rawQuery.trim()}%`;

    const searchQuery = `
        SELECT DISTINCT f.family_id, f.father_phone, f.mother_phone 
        FROM families f
        LEFT JOIN students s ON f.family_id = s.family_id
        WHERE f.father_phone = ? 
           OR f.mother_phone = ? 
           OR CAST(f.family_id AS TEXT) = ? 
           OR s.national_id = ?
           OR s.student_name LIKE ?
    `;

    db.all(searchQuery, [searchValue, searchValue, searchValue, searchValue, searchPattern], (err, families) => {
        if (err || !families || families.length === 0) {
            return res.status(404).json({ success: false, message: 'لم يتم العثور على سجلات مطابقة للبحث.' });
        }

        const family = families[0];

        const studentsQuery = `SELECT * FROM students WHERE family_id = ?`;
        db.all(studentsQuery, [family.family_id], (err, students) => {
            if (err) return res.status(500).json({ success: false, error: err.message });

            // Extract family name from first student's name
            let familyName = '';
            if (students.length > 0 && students[0].student_name) {
                const nameParts = students[0].student_name.trim().split(/\s+/);
                if (nameParts.length >= 3) {
                    familyName = nameParts.slice(1).join(' ');
                } else if (nameParts.length === 2) {
                    familyName = nameParts[1];
                } else {
                    familyName = students[0].student_name;
                }
            }
            family.family_name = familyName;

            let completed = 0;
            if (students.length === 0) {
                return res.json({ success: true, family, students: [] });
            }

            students.forEach(student => {
                const teachersQuery = `
                    SELECT teacher_name as name, subject, building_number as building, room_number as room, status 
                    FROM teachers_locations 
                    WHERE grade = ? AND curriculum = ? AND section = ?
                `;
                db.all(teachersQuery, [student.grade, student.curriculum, student.section], (err, teachers) => {
                    student.teachers = teachers || [];
                    completed++;
                    if (completed === students.length) {
                        res.json({ success: true, family, students });
                    }
                });
            });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`سيرفر أكاديمية الرواد تعمل بنجاح على المنفذ ${PORT}`);
});
