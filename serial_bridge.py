"""
====================================================================
🐠 AUCC 2026: ESP32 Hardware Serial Bridge (Python)
--------------------------------------------------------------------
สคริปต์เชื่อมต่อข้อมูลจริงจากบอร์ด ESP32 ผ่านพอร์ต USB Serial (COM Port)
อ่านค่าจากโปรแกรม water_monitor.ino (Temp, TDS, pH, Po Voltage)
และส่งขึ้น Express REST API Server (POST /api/readings) เพื่อแสดงผลบนหน้าเว็บแบบ Realtime
====================================================================
"""

import sys
import os
import time
import json
import re
import argparse
import urllib.request
import urllib.error

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("[ERROR] กรุณาติดตั้งโมดูล pyserial ก่อนใช้งาน:")
    print("        pip install pyserial")
    sys.exit(1)


def find_esp32_port():
    """ค้นหาพอร์ต COM ที่เป็นไปได้สำหรับ ESP32 (CP210x, CH340, FTDI)"""
    ports = list(serial.tools.list_ports.comports())
    if not ports:
        return None

    # ลำดับความสำคัญ: หาชิป USB-Serial ยอดนิยมของ ESP32 ก่อน
    for p in ports:
        desc = (p.description or "").lower()
        mfg = (p.manufacturer or "").lower()
        if "cp210" in desc or "ch340" in desc or "uart" in desc or "silicon labs" in desc or "ch341" in desc:
            return p.device

    # หากไม่พบชื่อเฉพาะ ให้ใช้พอร์ตแรกที่ตรวจพบ
    return ports[0].device


def parse_line(line):
    """
    แยกวิเคราะห์ข้อมูลจาก Serial ที่ส่งมาจาก water_monitor.ino
    รองรับทั้ง:
    1. รูปแบบข้อความเดิม:
       Temp: 25.0 C | TDS: 150 ppm | Po: 2.100 V | pH: 7.00
       Temp: N/A (ใช้ 25 C) | TDS: 150 ppm | Po: 2.100 V | pH: ยังไม่ปรับเทียบ
    2. รูปแบบ JSON:
       {"type":"water_data","temp":25.4,"tds":180,"ph":7.15,"phVolt":2.45,...}
    """
    line = line.strip()
    if not line:
        return None

    # แบบ JSON
    if line.startswith("{") and line.endswith("}"):
        try:
            data = json.loads(line)
            temp = float(data.get("temp", 25.0))
            tds = float(data.get("tds", 0))
            ph = float(data.get("ph", 7.0))
            ph_volt = float(data.get("phVolt", 2.5))
            temp_ok = bool(data.get("tempOk", True))
            ph_ok = bool(data.get("phValid", True))
            return {
                "temp": temp,
                "tds": int(round(tds)),
                "ph": round(ph, 2),
                "phVolt": ph_volt,
                "sensorOk": {
                    "temp": temp_ok,
                    "tds": True,
                    "ph": True,
                    "turbidity": True
                }
            }
        except Exception:
            pass

    # แบบ Text ของ water_monitor.ino
    # ตัวอย่าง: Temp: 26.2 C | TDS: 180 ppm | Po: 2.500 V | pH: 7.20
    if "Temp:" in line or "TDS:" in line or "Po:" in line:
        temp = 25.0
        temp_ok = True
        tds = 0.0
        po_volt = 2.5
        ph = 7.0
        ph_ok = True

        # Parse Temp
        m_temp = re.search(r'Temp:\s*([\d\.\-]+)\s*C', line)
        if m_temp:
            temp = float(m_temp.group(1))
            temp_ok = True
        elif "N/A" in line or "ใช้ 25 C" in line:
            temp = 25.0
            temp_ok = False

        # Parse TDS
        m_tds = re.search(r'TDS:\s*([\d\.\-]+)\s*ppm', line)
        if m_tds:
            tds = float(m_tds.group(1))

        # Parse Po Voltage
        m_po = re.search(r'Po:\s*([\d\.\-]+)\s*V', line)
        if m_po:
            po_volt = float(m_po.group(1))

        # Parse pH
        m_ph = re.search(r'pH:\s*([\d\.\-]+)', line)
        if m_ph:
            ph = float(m_ph.group(1))
            ph_ok = True
        elif "ยังไม่ปรับเทียบ" in line:
            # คำนวณค่าประมาณการจากแรงดัน Po (มาตรฐาน 2.5V ~ pH 7.0, ความชัน ~ -3.5)
            ph = round(7.0 - (po_volt - 2.5) * 3.5, 2)
            ph = max(0.0, min(14.0, ph))
            ph_ok = True

        return {
            "temp": round(temp, 1),
            "tds": int(round(tds)),
            "ph": round(ph, 2),
            "phVolt": round(po_volt, 3),
            "sensorOk": {
                "temp": temp_ok,
                "tds": True,
                "ph": ph_ok,
                "turbidity": True
            }
        }

    return None


def main():
    parser = argparse.ArgumentParser(description="AUCC ESP32 Serial to Web Bridge")
    parser.add_argument("--port", "-p", help="พอร์ต COM (เช่น COM3)")
    parser.add_argument("--baud", "-b", type=int, default=115200, help="Baud rate (เริ่มต้น 115200)")
    parser.add_argument("--server", "-s", default="http://localhost:3001/api/readings", help="URL ของ REST API Endpoint")
    parser.add_argument("--key", "-k", default=os.environ.get("ESP32_API_KEY", ""), help="X-API-KEY")
    args = parser.parse_args()

    port_name = args.port or find_esp32_port()
    if not port_name:
        print("❌ ไม่พบพอร์ต COM ของ ESP32 ในระบบ กรุณาเสียบสาย USB แล้วลองใหม่อีกครั้ง")
        sys.exit(1)

    print("================================================================")
    print("🐠 AUCC ESP32 Hardware Serial to Web Bridge")
    print("================================================================")
    print(f"🔌 Serial Port : {port_name} @ {args.baud} baud")
    print(f"📡 Web Server   : {args.server}")
    print("================================================================")
    print("💡 ข้อแนะนำ: หากเคยเปิด Serial Monitor ใน Arduino IDE ค้างไว้")
    print("   กรุณากด 'ปิด' Serial Monitor ใน Arduino IDE ก่อนเพื่อให้พอร์ตว่าง")
    print("================================================================\n")

    ser = None
    uptime = 0
    light_state = "ON"
    heater_state = "OFF"

    while True:
        # Loop เชื่อมต่อ Serial Port
        if ser is None or not ser.is_open:
            try:
                ser = serial.Serial(port_name, args.baud, timeout=1)
                print(f"✅ เชื่อมต่อกับพอร์ต {port_name} สำเร็จ! กำลังรอรับข้อมูลจริงจาก ESP32...\n")
            except serial.SerialException as e:
                err_str = str(e)
                if "PermissionError" in err_str or "Access is denied" in err_str:
                    print(f"⚠️  [พอร์ตไม่ว่าง] ไม่สามารถเปิด {port_name} ได้ เนื่องจากมีโปรแกรมอื่นเปิดค้างอยู่")
                    print("   👉 กรุณากดปิดหน้าต่าง Serial Monitor ในโปรแกรม Arduino IDE")
                else:
                    print(f"⚠️  [การเชื่อมต่อขัดข้อง] {err_str}")
                print("   (ระบบจะลองใหม่อัตโนมัติในอีก 2 วินาที...)")
                time.sleep(2)
                continue

        # อ่านข้อมูลจาก Serial
        try:
            raw_bytes = ser.readline()
            if not raw_bytes:
                continue

            line = raw_bytes.decode('utf-8', errors='ignore').strip()
            if not line:
                continue

            parsed = parse_line(line)
            if not parsed:
                # พิมพ์ข้อความทั่วไปจาก ESP32 เช่น สถานะการ calibrate
                if any(k in line for k in ["สถานะ", "บันทึก", "คำสั่ง", "เตือน", "Water Monitor"]):
                    print(f"ℹ️  [ESP32] {line}")
                continue

            uptime += 1
            payload = {
                "ph": parsed["ph"],
                "temp": parsed["temp"],
                "tds": parsed["tds"],
                "turbidityRaw": 1400,
                "sensorOk": parsed["sensorOk"],
                "rssi": -55,
                "uptimeSec": uptime,
                "actualStates": {
                    "light": light_state,
                    "heater": heater_state
                }
            }

            # ส่ง HTTP POST ขึ้น Web Server
            data_bytes = json.dumps(payload).encode('utf-8')
            headers = {"Content-Type": "application/json"}
            if args.key:
                headers["X-API-KEY"] = args.key
            req = urllib.request.Request(args.server, data=data_bytes, headers=headers, method="POST")

            t0 = time.time()
            try:
                with urllib.request.urlopen(req, timeout=4) as response:
                    latency = int((time.time() - t0) * 1000)
                    body = json.loads(response.read().decode('utf-8'))
                    commands = body.get("commands", [])

                    # ตรวจสอบคำสั่งควบคุม Relay ที่ Server ส่งกลับมา
                    for cmd in commands:
                        dev = cmd.get("device")
                        action = cmd.get("command")
                        reason = cmd.get("reason", "")
                        print(f"📥 [คำสั่งจากเซิร์ฟเวอร์] สั่ง {dev} -> {action} (เหตุผล: {reason})")
                        if dev == "light":
                            light_state = action
                        elif dev == "heater":
                            heater_state = action
                        # ส่งคำสั่งกลับไปยัง ESP32 ผ่าน Serial ด้วย
                        try:
                            ser.write(f"CMD:{dev}:{action}\n".encode('utf-8'))
                        except Exception:
                            pass

                    print(f"[{time.strftime('%H:%M:%S')}] 💧 ข้อมูลจริง: Temp={parsed['temp']}°C | TDS={parsed['tds']}ppm | pH={parsed['ph']} (Po={parsed.get('phVolt', 0)}V) | Latency={latency}ms -> ส่งขึ้นเว็บสำเร็จ ✅")

            except urllib.error.URLError as e:
                print(f"⚠️ [ไม่สามารถติดต่อ Web Server ได้]: {e.reason}")
                print(f"   ตรวจสอบว่าเปิด 'node server.js' หรือ 'npm start' หรือยังที่ {args.server}")
                time.sleep(1)

        except (serial.SerialException, serial.SerialTimeoutException) as e:
            print(f"⚠️ การเชื่อมต่อสาย Serial หลุด: {e}")
            if ser:
                try:
                    ser.close()
                except Exception:
                    pass
            ser = None
            time.sleep(2)
        except KeyboardInterrupt:
            print("\n👋 สิ้นสุดการทำงานตามคำสั่งผู้ใช้")
            break

    if ser and ser.is_open:
        ser.close()


if __name__ == "__main__":
    main()
