# 🐠 Smart Aquarium Dashboard & System Prototype (AUCC 2026)

ระบบศูนย์กลางติดตามคุณภาพน้ำในตู้ปลาแบบเรียลไทม์ และควบคุมอุปกรณ์ Relay (ไฟ และ ฮีตเตอร์) พร้อมระบบความปลอดภัย 6 ชั้น ออกแบบตามข้อกำหนดทางเทคนิค `design.md` และเอกสารสเปกโครงงาน AUCC 2026

---

## 📂 โครงสร้างไฟล์ในโปรเจกต์
* **`index.html`** : หน้าเว็บ Single Page Application แบบตอบสนองทุกอุปกรณ์ (Mobile Bottom Tab Bar + Desktop Sidebar) แสดงข้อมูลสดผ่าน REST API หรือเชื่อมต่อตรงกับ ESP32 ผ่าน **Web Serial API**; เมื่อ ESP32 ออฟไลน์จะแสดง `-` แทนค่าที่ไม่มีข้อมูล
* **`server.js`** : เซิร์ฟเวอร์ Node.js + Express REST API สำหรับ ESP32 Polling และ Command Queue บันทึกประวัติค่าเซนเซอร์ลง MongoDB ทุก 30 วินาที (หาก MongoDB ออฟไลน์ จะหยุดส่งข้อมูลลงฐานข้อมูลชั่วคราวโดยไม่สะสมคิวค้าง; พอร์ตเริ่มต้น 3001)
* **`serial_bridge.py`** : สคริปต์เชื่อมต่อสาย USB (COM Port) ระหว่างบอร์ด ESP32 (`water_monitor.ino`) กับ Backend Server ส่งข้อมูลจริงขึ้นหน้าเว็บอัตโนมัติ
* **`water_monitor/water_monitor.ino`** : โค้ด ESP32 Arduino Sketch ปรับปรุงใหม่ รองรับอ่าน TDS (pin 35), pH (pin 34) พร้อม 3-point calibration, DS18B20 Temp (pin 4) และส่งข้อมูลทั้งแบบข้อความเดิมและ JSON รวมถึงรองรับ Wi-Fi HTTP Post
* **`design.md`** : เอกสารการออกแบบสถาปัตยกรรมระบบฉบับสมบูรณ์ (C4 Context, Sequence, Database Schema, Safety Matrices, และ 30 Test Scenarios)
* **`test_esp32_simulator.py`** : สคริปต์ Python จำลองบอร์ด ESP32 ส่งข้อมูลทดสอบ

---

## 🗄️ เตรียม MongoDB และการบันทึกประวัติ

ESP32 ยังคงส่งข้อมูลทุก 3 วินาทีเพื่อให้ระบบตรวจจับความผิดปกติและสั่งงานความปลอดภัยได้ทันเวลา ส่วน Backend จะเก็บค่าล่าสุดลง MongoDB **ทุก 30 วินาที** หากฐานข้อมูลออฟไลน์ ระบบจะหยุดส่งข้อมูลลงฐานข้อมูลโดยอัตโนมัติ และจะกลับมาบันทึกต่อเมื่อฐานข้อมูลกลับมาออนไลน์ ข้อมูลประวัติจะถูกเก็บไว้จนกว่าจะลบเอง

1. เตรียม MongoDB ในเครื่อง หรือสร้างคลัสเตอร์ MongoDB Atlas
2. คัดลอก `.env.example` เป็น `.env` แล้วกำหนด `MONGODB_URI` และชื่อฐานข้อมูล หากใช้ Atlas ให้นำ connection string จากหน้า Atlas มาใส่โดยไม่ส่ง URI หรือรหัสผ่านในแชต
   ```env
   MONGODB_URI=mongodb://127.0.0.1:27017
   MONGODB_DB=smart_aquarium
   AQUARIUM_DEVICE_ID=aquarium-1
   DASHBOARD_API_KEY=ใส่คีย์สุ่มอีกชุดสำหรับ Dashboard
   ESP32_API_KEY=ใส่คีย์สุ่มยาวที่เก็บเป็นความลับ
   ```
   ถ้าตั้ง `ESP32_API_KEY` ให้ใช้ค่าเดียวกันใน `AQUARIUM_API_KEY` ใน `water_monitor/secrets.h` และห้าม commit ไฟล์ `.env` หรือ `water_monitor/secrets.h`
3. ติดตั้งแพ็กเกจและเริ่ม Backend:
   ```bash
   npm install
   npm start
   ```
4. ตรวจสถานะฐานข้อมูลได้ที่ `http://localhost:3001/api/health` และดูประวัติ 1 ชั่วโมงล่าสุดได้ที่ `http://localhost:3001/api/readings?range=1h`

หน้า Dashboard โหลดกราฟย้อนหลังจากข้อมูลจริงใน collection `readings` ตามช่วง 1 ชั่วโมง, 24 ชั่วโมง หรือ 7 วัน และรีเฟรชอัตโนมัติทุก 30 วินาที ปุ่มรับทราบ Alert จะบันทึก state ลง `app_state` ใน MongoDB เมื่อรันบน Vercel และลง `db.json` เมื่อรันในเครื่อง ส่วนการตรวจค่าเซนเซอร์แต่ละตัวจะแจ้ง Alert แยกกันเมื่อค่าผิดเกณฑ์พร้อมกันหลายรายการ

ข้อมูล sensor อยู่ใน collection `readings` และ state ของแอปอยู่ใน `app_state` บน Vercel; ในเครื่องยังใช้ `db.json` ได้ตามเดิม หาก MongoDB เชื่อมต่อไม่ได้บน Vercel API จะแจ้งสถานะผิดพลาดและไม่สลับไปใช้ไฟล์ชั่วคราว

MongoDB เก็บประวัติค่าเซนเซอร์ใน `readings` และ settings, alerts, commands, devices ใน `app_state` เมื่อ deploy บน Vercel ส่วนข้อมูล Telegram token จะไม่ถูกส่งกลับไปหน้าเว็บ

---

## 🔌 วิธีการเชื่อมต่อข้อมูลจริงจาก ESP32 (`water_monitor.ino`) ขึ้นหน้าเว็บ

คุณสามารถเชื่อมต่อข้อมูลจริงจากบอร์ด ESP32 ได้ถึง **3 วิธี** ตามความสะดวก:

### วิธีที่ 1: ผ่านปุ่ม Web Serial บนหน้าเว็บโดยตรง (ง่ายที่สุด ไม่ต้องรันสคริปต์เพิ่ม)
1. เสียบสาย USB ระหว่างคอมพิวเตอร์กับ ESP32
2. เปิดเบราว์เซอร์ Google Chrome หรือ Microsoft Edge ไปที่ **`http://localhost:3001`**
3. ที่มุมบนขวาของหน้าเว็บ ให้กดปุ่ม **`🔌 ต่อ USB ESP32`**
4. หน้าต่างเบราว์เซอร์จะเด้งให้เลือกพอร์ต เลือก **`Silicon Labs CP210x... (COM3)`** แล้วกด **Connect**
5. สถานะจะเปลี่ยนเป็น **`🟢 ต่อ USB อยู่`** และค่า Temp, TDS, pH จากบอร์ดจริงจะแสดงผลทันที!

> **หมายเหตุ:** ก่อนเชื่อมต่อ กรุณากดปิดหน้าต่าง Serial Monitor ใน Arduino IDE ก่อน เพื่อไม่ให้พอร์ต COM ชนกัน

---

### วิธีที่ 2: ผ่าน Python Serial Bridge (เชื่อมต่ออัตโนมัติผ่าน USB)
1. เปิด Terminal ในโฟลเดอร์นี้ แล้วรัน Backend Server:
   ```bash
   npm start
   ```
2. ปิด Serial Monitor ใน Arduino IDE
3. เปิดอีกหนึ่งหน้าต่าง Terminal แล้วสั่งรัน Serial Bridge:
   ```bash
   npm run bridge
   # หรือ
   python serial_bridge.py
   ```
4. สคริปต์จะค้นหาพอร์ต COM อัตโนมัติ (เช่น COM3) อ่านข้อมูลจริงจาก `water_monitor.ino` และยิงขึ้น `http://localhost:3001/api/readings` ทุก 1 วินาทีแบบเรียลไทม์

---

### วิธีที่ 3: ส่งตรงจาก ESP32 ผ่านเครือข่าย Wi-Fi (ไร้สาย)
1. คัดลอก `water_monitor/secrets.example.h` เป็น `water_monitor/secrets.h` แล้วกรอก SSID/รหัสผ่าน Wi-Fi, `AQUARIUM_SERVER_URL` และ API key ในไฟล์ใหม่นี้ ไฟล์ `secrets.h` ถูกยกเว้นจาก Git จึงไม่ถูกอัปโหลดขึ้น GitHub:
   ```cpp
   #define AQUARIUM_WIFI_SSID "ชื่อไวไฟของคุณ"
   #define AQUARIUM_WIFI_PASSWORD "รหัสผ่านไวไฟ"
   #define AQUARIUM_SERVER_URL "http://192.168.1.34:3001/api/readings"
   #define AQUARIUM_API_KEY "คีย์เดียวกับ ESP32_API_KEY ในไฟล์ .env"
   ```
2. ตรวจให้คอมพิวเตอร์กับ ESP32 อยู่ในเครือข่ายเดียวกัน และ URL ใน `water_monitor/secrets.h` เป็น IP ของคอมพิวเตอร์ที่ ESP32 เข้าถึงได้ (ค่าตัวอย่าง `192.168.1.34`; หาก IP เปลี่ยนให้ตรวจด้วย `ipconfig`)
3. เปิด Backend ที่พอร์ต 3001 แล้วอัปโหลดโค้ดลงบอร์ด ESP32
4. เปิด Serial Monitor ที่ 115200 baud: หากเห็น HTTP 2xx คือส่งสำเร็จ; หากไม่สำเร็จให้ตรวจ Wi-Fi, API key, IP และอนุญาต Node.js ผ่าน Windows Firewall
5. หน้าเว็บดึงข้อมูลล่าสุดจาก Backend อัตโนมัติทุก 3 วินาทีที่ `http://localhost:3001`

> หากใช้ Backend ในเครือข่ายท้องถิ่น ให้ตั้ง URL เป็น HTTP และ IP ของคอมพิวเตอร์ หากใช้ Vercel ให้ใช้ URL HTTPS และตั้งค่า TLS ตามหัวข้อ Deploy ด้านล่าง

## ☁️ เตรียม Deploy บน Vercel

โปรเจกต์นี้ตั้งค่า Vercel ให้เสิร์ฟ Dashboard จาก `public/` และรัน Express API เป็น Serverless Function ที่ `api/index.js` แล้ว เมื่อ `VERCEL=1` ระบบจะเก็บ readings และ application state ใน MongoDB Atlas; `db.json` ใช้เฉพาะการรันในเครื่องเท่านั้น

1. สร้าง MongoDB Atlas database และอนุญาตการเชื่อมต่อจาก Vercel ตามนโยบาย IP ของคลัสเตอร์ ห้ามนำ connection string หรือรหัสผ่านมาใส่ใน source code
2. ถ้าต้องการย้ายข้อมูลเดิม ให้ใส่ Atlas URI ใน `.env` บนเครื่องที่เก็บ `db.json` แล้วรัน `npm run migrate:vercel` ก่อน deploy; สคริปต์จะไม่เขียนทับ `app_state` ที่มีอยู่แล้ว
3. นำ repository ขึ้น GitHub หลังจากนำ credentials ที่ฝังในประวัติ Git ออก/เปลี่ยนค่าเรียบร้อยแล้ว และเชื่อม repository กับ Vercel
4. เพิ่ม Environment Variables ใน Vercel (Production และ Preview ตามต้องการ):
   - `MONGODB_URI`: connection string ของ Atlas
   - `MONGODB_DB`: `smart_aquarium`
   - `AQUARIUM_DEVICE_ID`: เช่น `aquarium-1`
   - `ESP32_API_KEY`: คีย์สุ่มยาวสำหรับ ESP32
   - `DASHBOARD_API_KEY`: คีย์สุ่มอีกชุดสำหรับปุ่มควบคุมและตั้งค่า Dashboard
5. Deploy แล้วตรวจ `https://<โดเมนของคุณ>/api/health` ต้องแสดง MongoDB เป็น `connected`
6. คัดลอก `water_monitor/secrets.example.h` เป็น `water_monitor/secrets.h`; ตั้ง `AQUARIUM_SERVER_URL` เป็น `https://<โดเมนของคุณ>/api/readings`, ใส่ Wi-Fi และ `AQUARIUM_API_KEY` ให้ตรงกับ `ESP32_API_KEY` จากนั้นใส่ PEM ของ trusted root CA ที่ออกใบรับรอง TLS ให้โดเมนนั้นใน `AQUARIUM_ROOT_CA` แล้วอัปโหลด sketch (ห้ามปิดการตรวจสอบใบรับรอง)

Dashboard จะขอ `DASHBOARD_API_KEY` เมื่อมีการสั่งงานหรือบันทึกการตั้งค่า และเก็บไว้เฉพาะ `sessionStorage` ของแท็บนั้น API อ่านข้อมูลยังเปิดให้ Dashboard อ่านได้ ส่วนการเปลี่ยนค่าและควบคุมอุปกรณ์ต้องใช้คีย์ สำหรับฐานข้อมูลใหม่ ระบบจะสร้าง state document ให้อัตโนมัติ; หากมีข้อมูลเดิมอยู่ใน `db.json` ให้นำเข้า/ย้ายข้อมูลก่อน deploy เพราะไฟล์นี้ไม่ถูกใช้เป็น persistent storage บน Vercel

### แก้ปัญหาค่า pH และ HTTP

- ถ้า Serial Monitor แสดง `แรงดันอยู่นอกช่วงคาลิเบรต` ระบบจะทำเครื่องหมายเซนเซอร์ pH ว่าผิดปกติและไม่ใช้ค่านั้นตัดสินคุณภาพน้ำ ให้ตรวจการต่อสาย/ไฟเลี้ยง/กราวด์ของโมดูล pH แล้วล้างการคาลิเบรตเดิมด้วย `c` ก่อนคาลิเบรตใหม่ด้วยสารละลายมาตรฐาน pH 4.00, 7.00 และ 10.00 ตามลำดับ โดยล้างหัววัดด้วยน้ำกลั่นและซับให้แห้งระหว่างสารละลาย ห้ามใช้ pH ของน้ำส้มสายชูหรือน้ำเบกกิ้งโซดาเป็นค่ามาตรฐานโดยประมาณ
- ค่าแรงดันที่อ่านได้ควรอยู่ในช่วงแรงดันที่บันทึกไว้ระหว่างคาลิเบรต ระบบจะไม่ extrapolate สมการออกนอกช่วงนั้น
- ตรวจ `SERVER_URL` ให้เป็น IP ของ Wi-Fi คอมพิวเตอร์ปัจจุบัน (`ipconfig`) และเปิด Backend ไว้ที่พอร์ต 3001 หากได้ HTTP 3xx ให้ดู `Location` ใน Serial Monitor เพราะ API นี้ควรตอบตรงโดยไม่ redirect

### ตั้งค่าการแจ้งเตือน Telegram
1. สร้างบอทผ่าน [@BotFather](https://t.me/BotFather) แล้วคัดลอก Bot Token
2. เปิดแชตกับบอทและกด Start จากนั้นหา Chat ID ของผู้รับ
3. เปิดหน้า **ตั้งค่า** ในเว็บ ใส่ Token และ Chat ID เลือกประเภทเหตุการณ์ แล้วกด **บันทึก**
4. กด **ทดสอบส่งข้อความ** และตรวจว่าข้อความเข้าห้อง Telegram

ระบบจะส่งข้อความเมื่อเกิดเหตุการณ์ใหม่ที่เลือกไว้ โดยเว้นการแจ้งซ้ำของเหตุการณ์เดิมตาม cooldown ของระบบ การตั้งค่า Token เก็บใน `db.json` เมื่อรันในเครื่องหรือใน MongoDB `app_state` บน Vercel และหน้าเว็บจะไม่แสดง Token ที่บันทึกแล้ว

---

## 🛡️ กฎความปลอดภัย 6 ชั้นสำหรับฮีตเตอร์ (Safety Interlocks)
1. **Overheat Cut-off:** ตัดฮีตเตอร์ทันทีเมื่อ $\ge 30^\circ\text{C}$ พร้อมล็อกปุ่มสั่งงาน
2. **Sensor Error:** สั่งปิดฮีตเตอร์ทันทีเมื่อเซนเซอร์อุณหภูมิขัดข้อง
3. **Heartbeat Timeout:** หากขาดการเชื่อมต่อเกิน 60 วินาที บอร์ด ESP32 จะตัดฮีตเตอร์ในระดับฮาร์ดแวร์เอง
4. **Max Continuous Run:** ฮีตเตอร์ทำงานต่อเนื่องได้สูงสุดไม่เกิน 2 ชั่วโมง
5. **Anti-chattering:** หน่วงเวลา Relay 45 วินาที ป้องกันหน้าสัมผัสสึกหรอ
6. **Action Confirmation:** การสั่งเปิดด้วยมือต้องยืนยันผ่าน Modal พร้อมแสดงอุณหภูมิน้ำปัจจุบัน

# Smart-Aquarium
