const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const dbPath = path.join(__dirname, 'school_event.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("خطأ في الاتصال بقاعدة البيانات:", err.message);
    } else {
        console.log("تم الاتصال بقاعدة البيانات school_event.db بنجاح.");
    }
});

function getDigits(val) {
    if (!val) return '';
    return String(val).replace(/\D/g, '');
}

function normalizePhone(val) {
    let d = getDigits(val);
    if (d.startsWith('962')) d = d.substring(3);
    if (d.startsWith('0')) d = d.substring(1);
    return d;
}

// Search API with Grade Filtering
app.get('/api/search', (req, res) => {
    const rawQuery = (req.query.query || '').trim();
    if (!rawQuery) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال قيمة للبحث' });
    }

    const cleanQ = getDigits(rawQuery);

    db.all(`SELECT * FROM families`, [], (err, families) => {
        if (err || !families || families.length === 0) {
            return res.json({ success: false, message: 'لم يتم العثور على سجلات مطابقة' });
        }

        const matchedFamily = families.find(f => {
            const famIdStr = String(f.family_id).trim();
            const natIdStr = String(f.national_id || '').trim();
            
            if (famIdStr === rawQuery || natIdStr === rawQuery) return true;

            const normQ = normalizePhone(rawQuery);
            const fatherNorm = normalizePhone(f.father_phone);
            const motherNorm = normalizePhone(f.mother_phone);

            if (normQ.length >= 3) {
                if (fatherNorm && (fatherNorm.includes(normQ) || normQ.includes(fatherNorm))) return true;
                if (motherNorm && (motherNorm.includes(normQ) || normQ.includes(motherNorm))) return true;
            }

            return false;
        });

        if (!matchedFamily) {
            return res.json({ success: false, message: 'لم يتم العثور على سجلات مطابقة' });
        }

        db.all(`SELECT * FROM students WHERE family_id = ?`, [matchedFamily.family_id], (err2, students) => {
            if (err2 || !students || students.length === 0) {
                return res.json({ success: true, family: matchedFamily, students: [] });
            }

            db.all(`SELECT * FROM teachers`, [], (err3, allTeachers) => {
                const fullStudents = students.map(student => {
                    const stGrade = (student.grade || '').trim();
                    // Filter teachers that teach this student's grade or 'جميع الصفوف'
                    const matchedTeachers = (allTeachers || []).filter(t => {
                        const gradesStr = (t.grades_handled || 'جميع الصفوف').trim();
                        if (gradesStr === 'جميع الصفوف' || gradesStr === 'الكل' || !gradesStr) return true;
                        return gradesStr.split(',').map(g => g.trim()).includes(stGrade);
                    });

                    student.teachers = matchedTeachers;
                    return student;
                });

                res.json({ success: true, family: matchedFamily, students: fullStudents });
            });
        });
    });
});

// Join Queue API
app.post('/api/queue/join', (req, res) => {
    const { teacher_id, family_id, student_name } = req.body;
    if (!teacher_id || !family_id) {
        return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
    }

    const nowIso = new Date().toISOString();

    db.get('SELECT * FROM queues WHERE teacher_id = ? AND family_id = ? AND status = "waiting"', [teacher_id, family_id], (err, row) => {
        if (row) {
            return res.json({ success: true, message: 'أنت مسجل في قائمة الانتظار بالفعل', queue_id: row.id });
        }
        db.run('INSERT INTO queues (teacher_id, family_id, student_name, status, created_at) VALUES (?, ?, ?, "waiting", ?)',
            [teacher_id, family_id, student_name, nowIso],
            function(err2) {
                if (err2) return res.status(500).json({ success: false, message: 'خطأ أثناء حجز الدور' });
                res.json({ success: true, message: 'تم حجز الدور بنجاح', queue_id: this.lastID });
            }
        );
    });
});

// Queue Status API
app.get('/api/queue/status', (req, res) => {
    const { teacher_id, family_id } = req.query;

    db.get('SELECT * FROM queues WHERE teacher_id = ? AND status = "serving"', [teacher_id], (err, servingRow) => {
        db.all('SELECT * FROM queues WHERE teacher_id = ? AND status = "waiting" ORDER BY id ASC', [teacher_id], (err2, waitingList) => {
            db.get('SELECT COUNT(*) as count FROM queues WHERE teacher_id = ? AND status = "completed"', [teacher_id], (err3, completedRow) => {
                let userPos = null;
                if (family_id && waitingList) {
                    const idx = waitingList.findIndex(q => String(q.family_id) === String(family_id));
                    if (idx !== -1) userPos = idx + 1;
                }

                res.json({
                    success: true,
                    serving: servingRow || null,
                    waiting_count: waitingList ? waitingList.length : 0,
                    completed_count: completedRow ? completedRow.count : 0,
                    waiting_list: waitingList || [],
                    user_position: userPos
                });
            });
        });
    });
});

// Teacher Next API
app.post('/api/queue/next', (req, res) => {
    const { teacher_id, action } = req.body;
    const nowIso = new Date().toISOString();

    db.run('UPDATE queues SET status = "completed", completed_at = ? WHERE teacher_id = ? AND status = "serving"', [nowIso, teacher_id], () => {
        if (action === 'next') {
            db.get('SELECT * FROM queues WHERE teacher_id = ? AND status = "waiting" ORDER BY id ASC LIMIT 1', [teacher_id], (err, nextRow) => {
                if (nextRow) {
                    db.run('UPDATE queues SET status = "serving", started_at = ? WHERE id = ?', [nowIso, nextRow.id], () => {
                        db.get('SELECT * FROM queues WHERE id = ?', [nextRow.id], (err2, updatedRow) => {
                            res.json({ success: true, serving: updatedRow });
                        });
                    });
                } else {
                    res.json({ success: true, serving: null, message: 'لا يوجد منتظرين في القائمة' });
                }
            });
        } else {
            res.json({ success: true, message: 'تم إنهاء المقابلة الحالية' });
        }
    });
});

// ADMIN APIS: Overview
app.get('/api/admin/overview', (req, res) => {
    db.all('SELECT * FROM teachers', [], (err, teachers) => {
        db.all('SELECT * FROM queues WHERE status IN ("waiting", "serving")', [], (err2, activeQueues) => {
            db.all('SELECT teacher_id, COUNT(*) as completed_count FROM queues WHERE status = "completed" GROUP BY teacher_id', [], (err3, completedStats) => {
                const statsMap = {};
                (completedStats || []).forEach(s => { statsMap[s.teacher_id] = s.completed_count; });

                res.json({
                    success: true,
                    teachers: teachers || [],
                    active_queues: activeQueues || [],
                    completed_stats: statsMap
                });
            });
        });
    });
});

// ADMIN APIS: Manage Teachers
app.get('/api/admin/teachers', (req, res) => {
    db.all('SELECT * FROM teachers', [], (err, teachers) => {
        res.json({ success: true, teachers: teachers || [] });
    });
});

app.post('/api/admin/teachers/add', (req, res) => {
    const { id, name, subject, building, room, grades_handled } = req.body;
    if (!id || !name || !subject || !building || !room) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال جميع بيانات المعلم' });
    }

    const grades = grades_handled || 'جميع الصفوف';

    db.run('INSERT INTO teachers (id, name, subject, building, room, grades_handled, status) VALUES (?, ?, ?, ?, ?, ?, "available")',
        [id, name, subject, building, room, grades],
        function(err) {
            if (err) return res.status(400).json({ success: false, message: 'معرف المعلم (ID) مستخدم بالفعل' });
            res.json({ success: true, message: 'تمت إضافة المعلم وتحديد صفوفه بنجاح' });
        }
    );
});

app.post('/api/admin/teachers/update', (req, res) => {
    const { id, name, subject, building, room, grades_handled } = req.body;
    if (!id || !name || !subject || !building || !room) {
        return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
    }

    const grades = grades_handled || 'جميع الصفوف';

    db.run('UPDATE teachers SET name = ?, subject = ?, building = ?, room = ?, grades_handled = ? WHERE id = ?',
        [name, subject, building, room, grades, id],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: 'فشل التعديل' });
            res.json({ success: true, message: 'تم تحديث بيانات المعلم والصفوف بنجاح' });
        }
    );
});

app.post('/api/admin/teachers/delete', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'معرف المعلم مطلوب' });

    db.run('DELETE FROM teachers WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'فشل الحذف' });
        res.json({ success: true, message: 'تم حذف المعلم بنجاح' });
    });
});

app.listen(PORT, () => {
    console.log(`السيرفر يعمل بنجاح على الرابط: http://localhost:${PORT}`);
});
