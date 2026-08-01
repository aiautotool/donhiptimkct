# Do Nhip Tim

App mobile đo nhịp tim bằng camera sau và đèn flash, chạy iOS/Android bằng Expo React Native kèm native module PPG riêng.

## Chức năng chính

- Đo nhịp tim BPM bằng camera/flash.
- Hiển thị BPM realtime khi đang đo.
- Tim giữa vòng tròn đập theo BPM realtime.
- Phát tiếng tít theo nhịp BPM đo được, tempo đổi theo BPM mới.
- Lưu kết quả đo kèm ghi chú tùy chọn và hoàn cảnh đo.
- Lịch sử lọc theo Ngày, Tuần, Tháng.
- Ước tính SpO2, nhịp thở, HRV, căng thẳng từ tín hiệu PPG.
- Đa ngôn ngữ Việt/Anh trong phần cài đặt.
- Khi chụp màn hình trên iOS, app tự tạo và cho phép gửi file log TXT.

## Lưu ý y tế

Ứng dụng chỉ phục vụ theo dõi sức khỏe tham khảo, không phải thiết bị y tế và không dùng để chẩn đoán hoặc điều trị.

## Cấu trúc quan trọng

- `App.tsx`: UI, flow đo, lưu lịch sử, ghi chú, đa ngôn ngữ, log, tiếng tít theo BPM.
- `modules/heart-rate-ppg/ios/HeartRatePpgModule.swift`: native PPG iOS, camera, flash, AE/AWB lock, thuật toán BPM/SpO2/nhịp thở.
- `modules/heart-rate-ppg/android/src/main/java/expo/modules/heartrateppg/HeartRatePpgModule.kt`: native PPG Android.
- `scripts/build-ios-device.sh`: build/cài iOS lên máy thật.
- `releases/`: APK Android build sẵn để cài trực tiếp.

## Cài dependency

```bash
npm install
```

## Chạy iOS máy thật Kct

```bash
npm run ios:device:kct:release
```

## Build APK Android cài trực tiếp

```bash
cd android
./gradlew assembleRelease
cd ..
mkdir -p releases
cp android/app/build/outputs/apk/release/app-release.apk releases/donhiptim-release.apk
```

APK sau build nằm tại:

```text
releases/donhiptim-release.apk
```

## Debug log

App không hiện nút debug log. Khi cần lấy log trên iOS, chụp màn hình trong app. Native sẽ gửi event về JS, JS ghi log ra TXT và mở share sheet để gửi file.

## Git

Repo public:

```text
https://github.com/aiautotool/donhiptimkct
```
