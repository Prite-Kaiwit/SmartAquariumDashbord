"""
ESP32 Mock Hardware Simulator (Python)
สำหรับจำลองบอร์ด ESP32 ยิง HTTP POST /api/readings ขึ้นเซิร์ฟเวอร์ทุก 3 วินาที
เพื่อทดสอบการทำงานของระบบและวัดค่า Latency สำหรับโครงงาน AUCC
"""

import time
import json
import os
import urllib.request
import urllib.error

API_URL = "http://localhost:3001/api/readings"
API_KEY = os.environ.get("ESP32_API_KEY", "")

print("====================================================")
print("🐠 ESP32 Hardware Simulation Client")
print("Target Server:", API_URL)
print("Sending sensor data every 3 seconds... (Press Ctrl+C to stop)")
print("====================================================")

temp = 26.2
light_state = "ON"
heater_state = "OFF"
uptime = 0

try:
    while True:
        uptime += 3
        # Simulate slight temperature fluctuation
        if heater_state == "ON":
            temp += 0.2
        else:
            temp += (time.time() % 3 - 1) * 0.05
        temp = round(temp, 2)

        payload = {
            "ph": round(7.20 + (time.time() % 5 - 2) * 0.02, 2),
            "temp": temp,
            "tds": int(180 + (time.time() % 7 - 3) * 2),
            "turbidityRaw": int(1400 + (time.time() % 11 - 5) * 10),
            "sensorOk": {
                "ph": True,
                "temp": True,
                "tds": True,
                "turbidity": True
            },
            "rssi": -63,
            "uptimeSec": uptime,
            "actualStates": {
                "light": light_state,
                "heater": heater_state
            }
        }

        data_bytes = json.dumps(payload).encode('utf-8')
        headers = {"Content-Type": "application/json"}
        if API_KEY:
            headers["X-API-KEY"] = API_KEY
        req = urllib.request.Request(API_URL, data=data_bytes, headers=headers, method="POST")

        t_start = time.time()
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                latency = int((time.time() - t_start) * 1000)
                body = json.loads(response.read().decode('utf-8'))
                commands = body.get("commands", [])

                # Process returned commands from server
                for cmd in commands:
                    dev = cmd.get("device")
                    state = cmd.get("command")
                    print(f"📥 [ESP32 Command Received] {dev} -> {state} (Reason: {cmd.get('reason')})")
                    if dev == "light":
                        light_state = state
                    elif dev == "heater":
                        heater_state = state

                print(f"[{time.strftime('%H:%M:%S')}] Temp: {temp}°C | pH: {payload['ph']} | TDS: {payload['tds']} | Relay[L:{light_state}, H:{heater_state}] | Latency: {latency}ms")
        except urllib.error.URLError as e:
            print(f"⚠️ [Connection Error] Cannot reach server: {e.reason}")

        time.sleep(3)

except KeyboardInterrupt:
    print("\nSimulation stopped by user.")
