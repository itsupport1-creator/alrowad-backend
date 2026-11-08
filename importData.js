const xlsx = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const db = new sqlite3.Database(path.join(__dirname, 'school_event.db'));

// توحيد وتنظيف أرقام الهواتف
function normalizePhone(phone) {
    if (!phone) return null;
    let str = phone.toString().trim().replace(/\s+/g, '').replace('+', '');
    if (str.startsWith('07')) {
        str = '962' + str.substring(1);
    } else if (str.startsWith('7') && str.length === 9) {
        str = '962' + str;
    }
    return str;
}

db.serialize(() => {
    // 1. إنشاء الجداول
    db.run(`CREATE TABLE IF NOT EXISTS families (
        family_id INTEGER PRIMARY KEY,
        father_phone TEXT,
        mother_phone TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
        national_id TEXT PRIMARY KEY,
        family_id INTEGER,
        student_name TEXT,
        gender TEXT,
        nationality TEXT,
        school TEXT,
        grade TEXT,
        curriculum TEXT,
        section TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS teachers_locations (
        teacher_id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_name TEXT,
        subject TEXT,
        school TEXT,
        grade TEXT,
        curriculum TEXT,
        section TEXT,
        building_number TEXT,
        room_number TEXT,
        status TEXT DEFAULT 'available'
    )`);

    console.log("✔ تم التحقق من هيكلية قاعدة البيانات.");

    // 2. البحث عن ملف الأكسل الموجود بالمجلد (عينة.xlsx أو عينة_2.xlsx)
    let excelFileName = 'عينة.xlsx';
    if (!fs.existsSync(path.join(__dirname, excelFileName))) {
        if (fs.existsSync(path.join(__dirname, 'عينة_2.xlsx'))) {
            excelFileName = 'عينة_2.xlsx';
        }
    }

    try {
        const studentFile = path.join(__dirname, excelFileName);
        console.log(`جاري قراءة الملف: ${excelFileName} ...`);

        const workbookStudents = xlsx.readFile(studentFile, { raw: false, cellDates: true });
        const sheetNameStudents = workbookStudents.SheetNames[0];
        
        // defval: "" تضمن عدم تخطي الأسطر التي تحتوي على حقول فارغة
        const studentsData = xlsx.utils.sheet_to_json(workbookStudents.Sheets[sheetNameStudents], { defval: "" });

        const stmtFamily = db.prepare(`INSERT OR REPLACE INTO families VALUES (?, ?, ?)`);
        const stmtStudent = db.prepare(`INSERT OR REPLACE INTO students VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        let importedStudentsCount = 0;
        let importedFamiliesCount = new Set();

        studentsData.forEach((row, index) => {
            const familyId = row['العائلة'];
            const studentName = row['اسم الطالب'];

            // تجاوز الأسطر الفارغة تماماً
            if (!familyId && !studentName) return;

            const fatherPhone = normalizePhone(row['خلوي الأب']);
            const motherPhone = normalizePhone(row['خلوي الأم']);
            const nationalId = (row['رقم الهوية'] || `AUTO_${index}`).toString();

            stmtFamily.run(familyId, fatherPhone, motherPhone);
            stmtStudent.run(
                nationalId,
                familyId,
                studentName || '',
                row['الجنس'] || '',
                row['الجنسية'] || '',
                row['المدرسة'] || '',
                row['الصف'] || '',
                row['المنهاج'] || '',
                row['الشعبة'] || ''
            );

            importedStudentsCount++;
            if (familyId) importedFamiliesCount.add(familyId);
        });

        stmtFamily.finalize();
        stmtStudent.finalize();

        console.log(`========================================`);
        console.log(`✔ اكتمل الاستيراد بنجاح!`);
        console.log(`- إجمالي عدد الطلاب المستوردين: ${importedStudentsCount}`);
        console.log(`- إجمالي عدد العائلات المستوردة: ${importedFamiliesCount.size}`);
        console.log(`========================================`);

    } catch (e) {
        console.log("⚠️ حدث خطأ أثناء قراءة الملف:", e.message);
    }

    // 3. قراءة ملف المعلمين والغرف إن وجد
    try {
        const teacherFile = path.join(__dirname, 'teachers.xlsx');
        if (fs.existsSync(teacherFile)) {
            const workbookTeachers = xlsx.readFile(teacherFile, { raw: false });
            const sheetNameTeachers = workbookTeachers.SheetNames[0];
            const teachersData = xlsx.utils.sheet_to_json(workbookTeachers.Sheets[sheetNameTeachers], { defval: "" });

            db.run(`DELETE FROM teachers_locations`);

            const stmtTeacher = db.prepare(`
                INSERT INTO teachers_locations 
                (teacher_name, subject, school, grade, curriculum, section, building_number, room_number, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            teachersData.forEach(row => {
                stmtTeacher.run(
                    row['اسم المعلم'] || row['المعلم'] || '',
                    row['المادة'] || '',
                    row['المدرسة'] || '',
                    row['الصف'] || '',
                    row['المنهاج'] || '',
                    row['الشعبة'] || '',
                    row['المبنى'] || row['رقم المبنى'] || '',
                    row['الغرفة'] || row['رقم الغرفة'] || '',
                    row['الحالة'] || 'available'
                );
            });

            stmtTeacher.finalize();
            console.log(`✔ تم استيراد ${teachersData.length} معلم وموقع غرفة من ملف (teachers.xlsx).`);
        }
    } catch (e) {
        console.log("⚠️ حدث خطأ أثناء قراءة ملف المعلمين:", e.message);
    }
});
