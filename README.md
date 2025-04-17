[![-----------------------------------------------------](https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/colored.png)](#table-of-contents)

<br>
<div align="center">
<img alt="rezadev05" src="./public/img/logo.png" width="420" height="auto" />
</div>
<br>

# 🎥 StreamApp - Application For Live Streaming With RTMP Protcol.

<p align="center">
<img width="" src="https://img.shields.io/github/repo-size/rezadev05/stream-app?color=green&label=Repo%20Size&style=for-the-badge&logo=appveyor">
</p>

StreamApp is a live streaming application, which allows you to go live on multiple platforms such as YouTube, Facebook and others. Using <b>RTMP</b> protocol, it can be run on VPS and other servers.

<p align="center">
   <img alt="screenshot" src="./public/img/preview-app.png" width="500px" height="auto" />
   </p>

<p align="center">
   <b>### How To Install ###</b>
</p>

```bash
$ apt update && apt upgrade
$ apt install git -y
$ apt install nodejs -y
$ apt install ffmpeg -y
$ npm install -g pm2
$ git clone https://github.com/rezadev05/stream-app.git
$ cd stream-app
$ npm install
$ pm2 start ecosystem.config.js --only stream-app
```

> **⚠️** <b>Note</b> This program must be run using nodejs version 20 or higher!

## Thanks To

- [`bangtutorial`](https://github.com/bangtutorial) (Base This Program⭐)
- [`rezadev05`](https://github.com/rezadev05)

`I would like to thank all contributors who helped create this source code.`

## Donate

<a href="https://saweria.co/rezadev05" target="_blank"><img src="https://user-images.githubusercontent.com/26188697/180601310-e82c63e4-412b-4c36-b7b5-7ba713c80380.png" alt="Donate For Reza" height="41" width="174"></a>
<a href="https://github.com/rezadev05/rezadev05/blob/main/bitcoin.json" target="_blank"><img src="https://github.com/rezadev05/rezadev05/blob/main/assets/bitcoin.png?raw=true" alt="Donate For Reza" height="41" width="174"></a>

## License

[MIT License](https://github.com/rezadev05/stream-app/LICENSE)

`Copyright (c) 2025 rezadev05`
