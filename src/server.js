const os = require("os");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const he = require("he");
const path = require("path");
const database = require("./database");
const EventSource = require("eventsource");
const rateLimit = require("express-rate-limit");
const sharp = require("sharp");
const mime = require("mime-types");
const app = express();

const thumbnailsDir = path.join(__dirname, "thumbnails");
if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}

// ================== KONFIGURASI UTAMA ==================

// Fungsi untuk menghasilkan session secret secara acak
const generateSessionSecret = () => crypto.randomBytes(32).toString("hex");
const uploadsTempDir = path.join(__dirname, "uploadsTemp");
if (!fs.existsSync(uploadsTempDir)) {
  fs.mkdirSync(uploadsTempDir, { recursive: true });
}

const uploadVideo = multer({ dest: uploadsTempDir });
const uploadAudio = multer({ dest: uploadsTempDir });
const upload = multer({ dest: uploadsTempDir });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "../public/img");
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => cb(null, "avatar.jpg"),
});

const uploadAvatar = multer({
  storage: avatarStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "image/jpeg") cb(null, true);
    else cb(new Error("Hanya file JPG/JPEG yang diperbolehkan"), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const avatarUpload = multer({
  storage: avatarStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "image/jpeg") {
      return cb(new Error("Only JPG files are allowed"));
    }
    cb(null, true);
  },
});

// Setup middleware
app.use(express.static(path.join(__dirname, "../public")));
app.use(express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "thumbnails")));
app.use(cors({ origin: true, credentials: true }));
app.use(
  session({
    secret: generateSessionSecret(),
    resave: true,
    saveUninitialized: false,
    cookie: { secure: false, sameSite: "lax", maxAge: 1000 * 60 * 60 },
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 7,
  message: {
    success: false,
    message:
      "Terlalu banyak percobaan login. Silakan coba lagi dalam 15 menit.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message:
        "Terlalu banyak percobaan login. Silakan coba lagi dalam 15 menit.",
    });
  },
});

// ================== ROUTING DASAR ==================
app.get("/", async (req, res) => handleRootRoute(req, res));
app.get("/login", async (req, res) => handleRootRoute(req, res));

async function handleRootRoute(req, res) {
  const userCount = await new Promise((resolve, reject) => {
    database.getUserCount((err, count) => {
      if (err) {
        console.error("Error getting user count:", err);
        return res.status(500).send("Internal Server Error");
      }
      resolve(count);
    });
  });

  if (userCount > 0) {
    if (req.session.user) {
      return res.redirect("/dashboard");
    } else {
      return res.sendFile(path.join(__dirname, "../public/login.html"));
    }
  } else {
    return res.redirect("/setup");
  }
}

// ================== AUTENTIKASI ==================

// Middleware untuk melindungi halaman HTML dan API
const requireAuthHTML = (req, res, next) => {
  if (!req.session.user) return res.redirect("/login");
  next();
};
const requireAuthAPI = (req, res, next) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Not authenticated" });
  next();
};

// API untuk mendapatkan username dari sesi
app.get("/api/user", requireAuthAPI, (req, res) => {
  res.json({ username: req.session.user.username });
});

// ================== ROUTING UTAMA ==================

app.get("/", (req, res) => res.redirect("/login"));

app.get("/history", requireAuthHTML, (req, res) => {
  res.sendFile(path.join(__dirname, "../views/history.html"));
});

app.get("/api/history", requireAuthAPI, (req, res) => {
  database.getHistoryStreamContainers((err, rows) => {
    if (err) return sendError(res, err.message);
    res.json(rows);
  });
});

app.delete("/delete-history/:id", requireAuthAPI, (req, res) => {
  const containerId = req.params.id;
  database.deleteStreamContainer(containerId, (err) => {
    if (err) return sendError(res, err.message);
    res.json({ message: "History streaming berhasil dihapus" });
  });
});

app.get("/gallery_video", requireAuthHTML, (req, res) => {
  res.sendFile(path.join(__dirname, "../views/gallery_video.html"));
});

app.get("/gallery_audio", requireAuthHTML, (req, res) => {
  res.sendFile(path.join(__dirname, "../views/gallery_audio.html"));
});

app.get("/settings", requireAuthHTML, (req, res) => {
  res.sendFile(path.join(__dirname, "../views/settings.html"));
});

// ================== MANAJEMEN USER ==================

// Endpoint untuk mendapatkan salt
app.get("/get-salt/:username", loginLimiter, async (req, res) => {
  const username = req.params.username;

  try {
    const user = await new Promise((resolve, reject) => {
      database.getUserSalt(username, (err, salt) => {
        if (err) reject(err);
        resolve(salt);
      });
    });

    if (!user) {
      return res.json({ success: false, message: "User tidak ditemukan" });
    }

    res.json({ success: true, salt: user.salt });
  } catch (error) {
    console.error("Get salt error:", error);
    res.json({ success: false, message: "Terjadi kesalahan" });
  }
});

app.post("/login", loginLimiter, async (req, res) => {
  const { username, hashedPassword } = req.body;

  try {
    const user = await new Promise((resolve, reject) => {
      database.verifyUser(username, hashedPassword, (err, user) => {
        if (err) reject(err);
        resolve(user);
      });
    });

    if (!user) {
      return res.json({
        success: false,
        message: "Username atau password salah",
      });
    }

    req.session.user = { username: username };
    req.session.save();
    res.json({ success: true });
  } catch (error) {
    console.error("Login error:", error);
    res.json({ success: false, message: "Terjadi kesalahan" });
  }
});

app.get("/check-auth", (req, res) =>
  res.json({ authenticated: !!req.session.user })
);
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Gagal logout" });
    res.redirect("/login");
  });
});

// ================== DASHBOARD ==================

app.get("/dashboard", requireAuthHTML, (req, res) => {
  res.sendFile(path.join(__dirname, "../views/index.html"));
});

// ================== PENGATURAN USER ==================

// Endpoint update-settings
app.post(
  "/update-settings",
  requireAuthAPI,
  uploadAvatar.single("avatar"),
  async (req, res) => {
    const { username, hashedPassword, salt } = req.body;

    try {
      const user = await new Promise((resolve, reject) => {
        database.getUser(req.session.user.username, (err, user) => {
          if (err) reject(err);
          resolve(user);
        });
      });

      if (!user) {
        throw new Error("User tidak ditemukan");
      }

      const userId = user.id;

      if (username && username !== req.session.user.username) {
        await new Promise((resolve, reject) => {
          database.updateUser(userId, { username }, (err) => {
            if (err) reject(err);
            resolve();
          });
        });
        req.session.user.username = username;
      }

      if (hashedPassword && salt) {
        await new Promise((resolve, reject) => {
          database.updateUser(
            userId,
            {
              password_hash: hashedPassword,
              salt: salt,
            },
            (err) => {
              if (err) reject(err);
              resolve();
            }
          );
        });
      }

      res.json({
        success: true,
        message: "Perubahan berhasil disimpan!",
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error("Update settings error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Gagal mengupdate pengaturan",
      });
    }
  }
);

app.post("/api/settings/update", requireAuthAPI, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;

  try {
    const user = await new Promise((resolve, reject) => {
      database.getUser(req.session.user.username, (err, user) => {
        if (err) reject(err);
        resolve(user);
      });
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }

    if (username && username !== user.username) {
      await new Promise((resolve, reject) => {
        database.updateUser(user.id, { username }, (err) => {
          if (err) {
            if (err.message.includes("UNIQUE")) {
              reject(new Error("Username sudah digunakan"));
            } else {
              reject(err);
            }
          }
          req.session.user.username = username;
          resolve();
        });
      });
    }

    if (currentPassword && newPassword) {
      const currentHash = CryptoJS.SHA256(
        currentPassword + user.salt
      ).toString();

      if (currentHash !== user.password_hash) {
        return res.status(400).json({
          success: false,
          message: "Password saat ini tidak sesuai",
        });
      }

      const newSalt = CryptoJS.lib.WordArray.random(16).toString();
      const newHash = CryptoJS.SHA256(newPassword + newSalt).toString();

      await new Promise((resolve, reject) => {
        database.updateUser(
          user.id,
          {
            password_hash: newHash,
            salt: newSalt,
          },
          (err) => {
            if (err) reject(err);
            resolve();
          }
        );
      });
    }

    res.json({
      success: true,
      message: "Pengaturan berhasil diperbarui",
    });
  } catch (error) {
    console.error("Settings update error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Gagal memperbarui pengaturan",
    });
  }
});

app.get("/api/user/profile", requireAuthAPI, async (req, res) => {
  try {
    const user = await new Promise((resolve, reject) => {
      database.getUser(req.session.user.username, (err, user) => {
        if (err) reject(err);
        resolve(user);
      });
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }

    res.json({
      success: true,
      username: user.username,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ================== MANAJEMEN VIDEO ==================

app.post("/upload-video", uploadVideo.single("video"), (req, res) => {
  if (!req.file) return sendError(res, "Tidak ada file yang diupload");

  const uploadsDir = path.join(__dirname, "uploads");
  const newFilePath = path.join(uploadsDir, req.file.originalname);

  if (fs.existsSync(newFilePath)) {
    fs.unlink(newFilePath, (err) => {
      if (err) {
        console.error("Error deleting existing file:", err);
        return sendError(res, "Gagal menghapus file yang sudah ada");
      }
      saveNewFile();
    });
  } else {
    saveNewFile();
  }

  function saveNewFile() {
    fs.rename(req.file.path, newFilePath, (err) => {
      if (err) {
        console.error("Error moving uploaded file:", err);
        return sendError(res, "Gagal mengupload video");
      }
      res.json({ message: "Upload berhasil", filePath: newFilePath });
    });
  }
});

app.post("/upload-audio", uploadAudio.single("audio"), (req, res) => {
  if (!req.file) return sendError(res, "Tidak ada file yang diupload");

  const uploadsDir = path.join(__dirname, "uploads");
  const newFilePath = path.join(uploadsDir, req.file.originalname);

  if (fs.existsSync(newFilePath)) {
    fs.unlink(newFilePath, (err) => {
      if (err) {
        console.error("Error deleting existing file:", err);
        return sendError(res, "Gagal menghapus file yang sudah ada");
      }
      saveNewFile();
    });
  } else {
    saveNewFile();
  }

  function saveNewFile() {
    fs.rename(req.file.path, newFilePath, (err) => {
      if (err) {
        console.error("Error moving uploaded file:", err);
        return sendError(res, "Gagal mengupload audio");
      }
      res.json({ message: "Upload berhasil", filePath: newFilePath });
    });
  }
});

app.post("/delete-video", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return sendError(res, "File path diperlukan");
  const isAbsolute = path.isAbsolute(filePath);
  const fullFilePath = isAbsolute
    ? filePath
    : path.join(__dirname, "uploads", filePath);
  fs.unlink(fullFilePath, (err) => {
    if (err) {
      console.error("Error deleting file:", err);
      return sendError(res, "Gagal menghapus file");
    }
    res.json({ message: "File berhasil dihapus" });
  });
});

app.post("/delete-audio", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return sendError(res, "File path diperlukan");
  const isAbsolute = path.isAbsolute(filePath);
  const fullFilePath = isAbsolute
    ? filePath
    : path.join(__dirname, "uploads", filePath);
  fs.unlink(fullFilePath, (err) => {
    if (err) {
      console.error("Error deleting file:", err);
      return sendError(res, "Gagal menghapus file");
    }
    res.json({ message: "File berhasil dihapus" });
  });
});

app.get("/video/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "uploads", filename);

  fs.stat(filePath, (err, stat) => {
    if (err) {
      if (err.code === "ENOENT") return res.status(404).send("File not found");
      else return res.status(500).send("File system error");
    }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  });
});

app.get("/audio/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "uploads", filename);

  fs.stat(filePath, (err, stat) => {
    if (err) {
      if (err.code === "ENOENT") return res.status(404).send("File not found");
      else return res.status(500).send("File system error");
    }

    res.writeHead(200, {
      "Content-Type": "audio/mp3",
      "Content-Length": stat.size,
    });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  });
});

// Endpoint untuk streaming video
app.get("/uploads/:filename", (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(__dirname, "uploads", filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;

    if (start >= fileSize || end >= fileSize) {
      res.status(416).send("Requested range not satisfiable");
      return;
    }

    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/mp4",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Endpoint untuk mendapatkan list video dari folder uploads
app.get("/api/videos", requireAuthAPI, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 8;
  const offset = (page - 1) * limit;
  const uploadsDir = path.join(__dirname, "uploads");

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  try {
    const allFiles = fs.readdirSync(uploadsDir).filter((file) => {
      const isVideoFile = [".mp4", ".mkv", ".avi"].includes(
        path.extname(file).toLowerCase()
      );
      const isNotStreamingFile = !file.startsWith("streaming_videodata_");
      return isVideoFile && isNotStreamingFile;
    });

    const totalStorage = allFiles.reduce((acc, file) => {
      const stats = fs.statSync(path.join(uploadsDir, file));
      return acc + stats.size / (1024 * 1024);
    }, 0);

    const sortedFiles = allFiles.sort((a, b) => {
      const statA = fs.statSync(path.join(uploadsDir, a));
      const statB = fs.statSync(path.join(uploadsDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });

    const paginatedFiles = sortedFiles.slice(offset, offset + limit);

    const videosWithInfo = await Promise.all(
      paginatedFiles.map(async (file) => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        const duration = await new Promise((resolve) => {
          ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
              resolve("00:00");
              return;
            }
            const seconds = metadata.format.duration;
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = Math.floor(seconds % 60);
            resolve(
              `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
            );
          });
        });

        return {
          name: file,
          path: `/uploads/${file}`,
          size: (stats.size / (1024 * 1024)).toFixed(2),
          modified: stats.mtime,
          type: "video/mp4",
          duration,
        };
      })
    );

    res.json({
      videos: videosWithInfo,
      total: allFiles.length,
      currentPage: page,
      totalPages: Math.ceil(allFiles.length / limit),
      totalStorage: totalStorage.toFixed(2),
      hasMore: offset + limit < allFiles.length,
    });
  } catch (err) {
    console.error("Error reading videos:", err);
    res.status(500).json({ error: "Failed to read videos" });
  }
});

app.get("/api/audios", requireAuthAPI, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 8;
  const offset = (page - 1) * limit;
  const uploadsDir = path.join(__dirname, "uploads");

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  try {
    const allFiles = fs.readdirSync(uploadsDir).filter((file) => {
      const isAudioFile = [".mp3", ".wav", ".acc"].includes(
        path.extname(file).toLowerCase()
      );
      const isNotStreamingFile = !file.startsWith("streaming_audiodata_");
      return isAudioFile && isNotStreamingFile;
    });

    const totalStorage = allFiles.reduce((acc, file) => {
      const stats = fs.statSync(path.join(uploadsDir, file));
      return acc + stats.size / (1024 * 1024);
    }, 0);

    const sortedFiles = allFiles.sort((a, b) => {
      const statA = fs.statSync(path.join(uploadsDir, a));
      const statB = fs.statSync(path.join(uploadsDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });

    const paginatedFiles = sortedFiles.slice(offset, offset + limit);

    const audiosWithInfo = await Promise.all(
      paginatedFiles.map(async (file) => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        const duration = await new Promise((resolve) => {
          ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
              resolve("00:00");
              return;
            }
            const seconds = metadata.format.duration;
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = Math.floor(seconds % 60);
            resolve(
              `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
            );
          });
        });

        return {
          name: file,
          path: `/uploads/${file}`,
          size: (stats.size / (1024 * 1024)).toFixed(2),
          modified: stats.mtime,
          type: "audio/mp3",
          duration,
        };
      })
    );

    res.json({
      audios: audiosWithInfo,
      total: allFiles.length,
      currentPage: page,
      totalPages: Math.ceil(allFiles.length / limit),
      totalStorage: totalStorage.toFixed(2),
      hasMore: offset + limit < allFiles.length,
    });
  } catch (err) {
    console.error("Error reading audios:", err);
    res.status(500).json({ error: "Failed to read audios" });
  }
});

// Endpoint untuk daftar video di popup tambah video
app.get("/api/videos-all", requireAuthAPI, async (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const files = await fs.promises.readdir(uploadsDir);
    const videoList = await Promise.all(
      files
        .filter((file) => {
          const isVideoFile = file.match(/\.(mp4|mkv|avi|mov|wmv)$/i);
          const isNotStreamingFile = !file.startsWith("streaming_videodata_");
          return isVideoFile && isNotStreamingFile;
        })
        .map(async (file) => {
          const filePath = path.join(uploadsDir, file);
          const stats = await fs.promises.stat(filePath);

          const duration = await new Promise((resolve) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
              if (err) {
                console.error("Error getting duration:", err);
                resolve("00:00");
                return;
              }
              const seconds = metadata.format.duration;
              const minutes = Math.floor(seconds / 60);
              const remainingSeconds = Math.floor(seconds % 60);
              resolve(
                `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
              );
            });
          });

          return {
            name: file,
            path: `/uploads/${file}`,
            duration: duration,
            size: (stats.size / (1024 * 1024)).toFixed(2) + " MB",
            created: stats.birthtime,
          };
        })
    );

    videoList.sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      success: true,
      videos: videoList || [],
    });
  } catch (error) {
    console.error("Error reading videos directory:", error);
    res.status(500).json({
      success: false,
      error: "Failed to read videos directory",
      videos: [],
    });
  }
});

app.get("/api/audios-all", requireAuthAPI, async (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const files = await fs.promises.readdir(uploadsDir);
    const audioList = await Promise.all(
      files
        .filter((file) => {
          const isAudioFile = file.match(/\.(mp3|wav|acc)$/i);
          const isNotStreamingFile = !file.startsWith("streaming_audiodata_");
          return isAudioFile && isNotStreamingFile;
        })
        .map(async (file) => {
          const filePath = path.join(uploadsDir, file);
          const stats = await fs.promises.stat(filePath);

          const duration = await new Promise((resolve) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
              if (err) {
                console.error("Error getting duration:", err);
                resolve("00:00");
                return;
              }
              const seconds = metadata.format.duration;
              const minutes = Math.floor(seconds / 60);
              const remainingSeconds = Math.floor(seconds % 60);
              resolve(
                `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
              );
            });
          });

          return {
            name: file,
            path: `/uploads/${file}`,
            duration: duration,
            size: (stats.size / (1024 * 1024)).toFixed(2) + " MB",
            created: stats.birthtime,
          };
        })
    );

    audioList.sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      success: true,
      audios: audioList || [],
    });
  } catch (error) {
    console.error("Error reading audio directory:", error);
    res.status(500).json({
      success: false,
      error: "Failed to read audio directory",
      audios: [],
    });
  }
});

// ================== STREAMING ==================

const streams = {};
const monitorStreams = new Map();
const scheduledStreams = new Map();

app.post(
  "/start-stream",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        rtmp_url,
        stream_key,
        bitrate,
        fps,
        resolution,
        loop,
        audio_file,
        title,
        schedule_enabled,
        schedule_start_enabled,
        schedule_start,
        schedule_duration,
      } = req.body;

      const videoFile = req.files["video"]?.[0];
      const audioFile = req.files["audio"]?.[0];

      const isKeyUsedInDB = await new Promise((resolve, reject) => {
        database.getStreamContainerByKey(stream_key, (err, row) => {
          if (err) return reject(err);
          resolve(row && row.is_streaming === 1);
        });
      });

      if (streams[stream_key] || isKeyUsedInDB) {
        return sendError(
          res,
          "Stream key sudah digunakan. Mohon gunakan stream key lain atau hentikan stream yang sedang berjalan."
        );
      }

      if (!videoFile) return sendError(res, "Video tidak ditemukan");
      // if (!audioFile) return sendError(res, "Audio tidak ditemukan");
      if (!title) return sendError(res, "Judul belum diisi");

      const videoExt = path.extname(videoFile.originalname).toLowerCase();
      const audioExt = audioFile
        ? path.extname(audioFile.originalname).toLowerCase()
        : null;

      if (videoExt === "")
        return sendError(res, "Ekstensi file video tidak ditemukan.");
      if (audioFile && audioExt === "")
        return sendError(res, "Ekstensi file audio tidak ditemukan.");

      const videoFileName = `${generateRandomFileNameVideo()}${videoExt}`;

      const uploadsDir = path.join(__dirname, "uploads");

      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const videoFilePath = path.join(uploadsDir, videoFileName);

      let audioFileName = null;
      let audioFilePath = null;

      if (audioFile) {
        audioFileName = `${generateRandomFileNameAudio()}${audioExt}`;
        audioFilePath = path.join(uploadsDir, audioFileName);
        fs.renameSync(audioFile.path, audioFilePath);
      }

      fs.renameSync(videoFile.path, videoFilePath);

      console.log("start-streaming:", {
        rtmp_url,
        bitrate,
        fps,
        resolution,
        title,
        loop,
        audio_file,
      });

      if (schedule_enabled === "1" && schedule_start_enabled === "1") {
        const startTime = new Date(schedule_start).getTime();
        const duration = schedule_duration
          ? parseInt(schedule_duration, 10) * 60 * 1000
          : null;

        const containerData = {
          title,
          preview_file_video: videoFile.originalname,
          preview_file_audio: audioFile?.originalname || null,
          stream_file_video: videoFileName,
          stream_file_audio: audioFileName || null,
          stream_key,
          stream_url: rtmp_url,
          bitrate: parseInt(bitrate, 10),
          resolution,
          fps: parseInt(fps, 10),
          loop_enabled: loop === "true" ? 1 : 0,
          audio_enabled: audio_file === "true" ? 1 : 0,
          container_order: Date.now(),
          is_streaming: 1,
          schedule_enabled: 1,
          schedule_start_enabled: 1,
          schedule_duration_enabled: parseInt(
            req.body.schedule_duration_enabled,
            10
          ),
          schedule_start,
          schedule_duration: duration ? Math.floor(duration / 1000 / 60) : null,
        };

        const result = await new Promise((resolve, reject) => {
          database.addStreamContainer(containerData, (err, data) => {
            if (err) reject(err);
            resolve(data);
          });
        });

        scheduleStream(
          {
            videoPath: videoFilePath,
            audioPath: audioFilePath,
            stream_key,
            rtmp_url,
            containerId: result.lastID,
            fps,
            bitrate,
            resolution,
            loop,
            audio_file,
          },
          startTime,
          duration
        );

        return res.json({
          message: "Stream scheduled",
          scheduled: true,
          startTime,
          duration,
        });
      }

      const command = ffmpeg(videoFilePath)
        .inputFormat("mp4")
        .inputOptions([
          "-re",
          ...(loop === "true" ? ["-stream_loop", "-1"] : []),
        ]);

      if (audio_file && audioFilePath) {
        command
          .input(audioFilePath)
          .inputOptions([
            "-re",
            ...(loop === "true" ? ["-stream_loop", "-1"] : []),
          ]);
      }

      const outputOptions = [
        `-r ${fps || 30}`,
        "-threads 2",
        '-x264-params "nal-hrd=cbr"',
        "-c:v libx264",
        "-preset veryfast",
        "-tune zerolatency",
        `-b:v ${bitrate}k`,
        `-maxrate ${bitrate}k`,
        `-bufsize ${bitrate * 2}k`,
        "-pix_fmt yuv420p",
        "-g 60",
        `-vf scale=${resolution}`,
        "-c:a aac",
        "-b:a 128k",
        "-ar 44100",
        "-f flv",
      ];

      if (audio_file && audioFilePath) {
        outputOptions.push(
          "-map 0:v:0", // video dari input 0 (video)
          "-map 1:a:0" // audio dari input 1 (audio eksternal)
        );
      } else {
        outputOptions.push(
          "-map 0:v:0", // video dari input 0
          "-map 0:a?" // audio dari input 0 jika ada
        );
      }

      command.outputOptions(outputOptions);
      command.output(`${rtmp_url}/${stream_key}`);

      command.on("start", async (cmdLine) => {
        console.log("FFmpeg started:", cmdLine);
      });

      const duration = parseInt(schedule_duration, 10) * 60 * 1000; // Convert menit ke ms
      if (schedule_enabled === "1" && duration) {
        setTimeout(() => {
          if (streams[stream_key]) {
            try {
              streams[stream_key].process.on("error", (err) => {
                if (
                  err.message.includes("Exiting normally, received signal 15")
                ) {
                  return;
                }
                console.error("FFmpeg error:", err);
              });

              streams[stream_key].process.kill("SIGTERM");
              database.updateStreamContainer(
                streams[stream_key].containerId,
                { is_streaming: 0, auto_stopped: true },
                (err) => {
                  if (err) console.error("Error updating stream status:", err);
                }
              );

              if (videoFilePath) {
                deleteFile(videoFilePath);
              }

              if (audio_file && audioFilePath) {
                deleteFile(audioFilePath);
              }
              delete streams[stream_key];
            } catch (error) {
              console.error("Error stopping stream:", error);
            }
          }
        }, duration);
      }

      let responseSent = false;
      let containerId;

      try {
        const containerData = {
          title: title,
          preview_file_video: videoFile.originalname,
          preview_file_audio: audioFile?.originalname || null,
          stream_file_video: videoFileName,
          stream_file_audio: audioFileName || null,
          stream_key: stream_key,
          stream_url: rtmp_url,
          bitrate: parseInt(bitrate, 10),
          resolution: resolution,
          fps: parseInt(fps, 10),
          loop_enabled: loop === "true" ? 1 : 0,
          audio_enabled: audio_file === "true" ? 1 : 0,
          container_order: Date.now(),
          is_streaming: 1,
          schedule_enabled: parseInt(req.body.schedule_enabled, 10),
          schedule_start_enabled: parseInt(req.body.schedule_start_enabled, 10),
          schedule_duration_enabled: parseInt(
            req.body.schedule_duration_enabled,
            10
          ),
          schedule_start: req.body.schedule_start || null,
          schedule_duration: req.body.schedule_duration
            ? parseInt(req.body.schedule_duration, 10)
            : null,
        };

        const result = await new Promise((resolve, reject) => {
          database.addStreamContainer(containerData, (err, data) => {
            if (err) {
              reject(new Error(`Database error: ${err.message}`));
              return;
            }
            resolve(data);
          });
        });
        containerId = result.lastID;

        if (!result) throw new Error("Gagal menyimpan data ke database");

        streams[stream_key] = {
          process: command,
          startTime: Date.now(),
          containerId: containerId,
          videoPath: videoFilePath,
          audioPath: audioFilePath,
          audio_file: audio_file,
          duration: duration,
        };

        command
          .on("end", () => {
            console.log("Streaming selesai:", stream_key);
            const monitor = monitorStreams.get(stream_key);
            if (monitor) {
              monitor.isActive = false;
            }
            delete streams[stream_key];
            database.updateStreamContainer(
              containerId,
              { is_streaming: 0 },
              (err) => {
                if (err) console.error("Error updating database:", err);
                if (videoFilePath) {
                  deleteFile(videoFilePath);
                }

                if (audio_file && audioFilePath) {
                  deleteFile(audioFilePath);
                }
              }
            );
          })

          .on("error", (err) => {
            if (err.message.includes("Exiting normally, received signal 15")) {
              console.log("Streaming dihentikan:", stream_key);
              return;
            }

            console.error("Stream error:", err);
            delete streams[stream_key];

            database.deleteStreamContainer(containerId, (err) => {
              if (err) console.error("Error delete database:", err);
              if (videoFilePath) {
                deleteFile(videoFilePath);
              }

              if (audio_file && audioFilePath) {
                deleteFile(audioFilePath);
              }
              console.log("Stream container deleted:", containerId);
            });

            if (!responseSent) {
              sendError(res, "Error during streaming", 500);
              responseSent = true;
            }
          })

          //JALANKAN STREAMING
          .run();

        setTimeout(() => {
          if (!responseSent) {
            res.json({
              message: "Streaming dimulai",
              stream_key,
              containerId: containerId,
            });
            responseSent = true;
          }
        }, 5000);
      } catch (error) {
        console.error("Error starting stream:", error);
        if (!responseSent) {
          sendError(res, `Failed to start stream: ${error.message}`);
          responseSent = true;
        }
      }
    } catch (error) {
      console.error("Error processing video:", error);
      sendError(res, `Error processing video: ${error.message}`);
    }
  }
);

app.post("/stop-stream", async (req, res) => {
  const { stream_key } = req.body;
  const stream = streams[stream_key];

  if (stream) {
    try {
      const { containerId, videoPath, audioPath, audio_file } = stream;
      const monitor = monitorStreams.get(stream_key);
      if (monitor) {
        monitor.isActive = false;
      }

      if (stream.process && stream.process.ffmpegProc) {
        stream.process.on("error", (err) => {
          if (err.message.includes("Exiting normally, received signal 15")) {
            return;
          }
          console.error("FFmpeg error:", err);
        });

        stream.process.kill("SIGTERM");
      }

      delete streams[stream_key];
      monitorStreams.delete(stream_key);

      await new Promise((resolve, reject) => {
        database.updateStreamContainer(
          containerId,
          { is_streaming: 0 },
          (err) => {
            if (err) return reject(err);
            if (videoPath) {
              deleteFile(videoPath);
            }

            if (audio_file && audioPath) {
              deleteFile(audioPath);
            }
            resolve();
          }
        );
      });

      res.json({ message: "Streaming dihentikan" });
    } catch (error) {
      console.error("Error stopping stream:", error);
      sendError(res, "Gagal menghentikan stream: " + error.message);
    }
  } else {
    sendError(res, "Stream tidak ditemukan", 404);
  }
});

app.get("/stream-containers", requireAuthAPI, (req, res) => {
  database.getStreamContainers((err, rows) => {
    if (err) return sendError(res, err.message);
    res.json(rows);
  });
});

app.get("/active-stream-containers", requireAuthAPI, (req, res) => {
  database.getActiveStreamContainers((err, rows) => {
    if (err) return sendError(res, err.message);
    res.json(rows);
  });
});

// Endpoint untuk status streaming
app.get("/stream-status/:streamKey", (req, res) => {
  const streamKey = req.params.streamKey;
  const stream = streams[streamKey];

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (!stream) {
    res.write(
      `data: ${JSON.stringify({
        is_streaming: false,
        auto_stopped: true,
      })}\n\n`
    );
    return res.end();
  }

  if (!monitorStreams.has(streamKey)) {
    monitorStreams.set(streamKey, {
      lastCheck: Date.now(),
      isActive: true,
    });
  }

  const intervalId = setInterval(() => {
    const monitor = monitorStreams.get(streamKey);
    if (!monitor || !monitor.isActive) {
      clearInterval(intervalId);
      res.end();
      return;
    }

    try {
      if (stream && stream.process) {
        process.kill(stream.process.ffmpegProc.pid, 0);
        res.write(`data: ${JSON.stringify({ is_streaming: true })}\n\n`);
        monitor.lastCheck = Date.now();
      } else {
        throw new Error("Process not found");
      }
    } catch (e) {
      clearInterval(intervalId);
      res.end();
    }
  }, 5000);

  res.on("close", () => {
    clearInterval(intervalId);
  });
});

// ================== SETUP AKUN ==================

app.get("/setup", async (req, res) => {
  const userCount = await new Promise((resolve, reject) => {
    database.getUserCount((err, count) => {
      if (err) reject(err);
      resolve(count);
    });
  });
  if (userCount > 0) return res.redirect("/dashboard");
  res.sendFile(path.join(__dirname, "../public/setup.html"));
});

app.post("/setup", uploadAvatar.single("avatar"), async (req, res) => {
  const { username, hashedPassword, salt } = req.body;

  if (!username || !hashedPassword || !salt) {
    return sendError(res, "Data tidak lengkap");
  }

  try {
    await new Promise((resolve, reject) => {
      database.addUser(username, hashedPassword, salt, (err) => {
        if (err) reject(err);
        resolve();
      });
    });

    req.session.user = { username: username };
    req.session.save();
    res.redirect("/dashboard");
  } catch (error) {
    console.error("Setup akun error:", error);
    sendError(res, error.message || "Gagal membuat akun");
  }
});

// ================== HELPER FUNCTIONS ==================

const sendError = (res, message, status = 400) =>
  res.status(status).json({ success: false, message });

const handleServerError = (res, err) => {
  console.error("Server error:", err);
  res.status(500).send("Internal Server Error");
};

const deleteFile = (filePath) => {
  fs.unlink(filePath, (err) => {});
};

const generateRandomFileNameVideo = () =>
  `streaming_videodata_${crypto.randomBytes(16).toString("hex")}`;

const generateRandomFileNameAudio = () =>
  `streaming_audiodata_${crypto.randomBytes(16).toString("hex")}`;

const ifaces = os.networkInterfaces();
let ipAddress = "localhost";
for (const iface of Object.values(ifaces)) {
  for (const alias of iface) {
    if (alias.family === "IPv4" && !alias.internal) {
      ipAddress = alias.address;
      break;
    }
  }
  if (ipAddress !== "localhost") break;
}

// Endpoint untuk generate thumbnail
app.get("/thumbnails/:filename", async (req, res) => {
  const videoPath = path.join(__dirname, "uploads", req.params.filename);
  const thumbnailPath = path.join(
    __dirname,
    "thumbnails",
    `${req.params.filename}.jpg`
  );

  const thumbnailsDir = path.join(__dirname, "thumbnails");
  if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  }

  try {
    if (!fs.existsSync(thumbnailPath)) {
      if (!fs.existsSync(videoPath)) {
        return res.status(404).send("Video not found");
      }

      const mimeType = mime.lookup(videoPath);

      if (mimeType && mimeType.startsWith("video/")) {
        try {
          await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
              .screenshots({
                count: 1,
                folder: thumbnailsDir,
                filename: `${req.params.filename}.jpg`,
                size: "480x270",
              })
              .on("end", resolve)
              .on("error", reject);
          });
        } catch (ffmpegError) {
          console.warn(
            "FFmpeg failed, using default audio-style thumbnail:",
            ffmpegError
          );
          await generateDefaultThumbnail(thumbnailPath);
        }
      } else if (mimeType && mimeType.startsWith("audio/")) {
        await generateDefaultThumbnail(thumbnailPath);
      }
    }

    res.sendFile(thumbnailPath);
  } catch (error) {
    console.error("Error handling thumbnail:", error);
    res.status(500).send("Error generating thumbnail");
  }
});

async function generateDefaultThumbnail(thumbnailPath) {
  const outputBuffer = await sharp({
    create: {
      width: 480,
      height: 270,
      channels: 3,
      background: "#222",
    },
  })
    .composite([
      {
        input: path.join(__dirname, "/thumbnails/audio-thumb.jpg"),
        gravity: "center",
      },
    ])
    .jpeg()
    .toBuffer();

  fs.writeFileSync(thumbnailPath, outputBuffer);
}

// Endpoint untuk Google Drive API key
app.get("/api/drive-api-key", requireAuthAPI, async (req, res) => {
  try {
    const apiKey = await database.getSetting("drive_api_key");
    res.json({ apiKey });
  } catch (error) {
    sendError(res, "Failed to get API key");
  }
});

// Endpoint untuk menyimpan API key
app.post("/api/drive-api-key", requireAuthAPI, async (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey) {
    return res.status(400).json({
      success: false,
      message: "API key tidak boleh kosong",
    });
  }

  try {
    await database.saveSetting("drive_api_key", apiKey);
    res.json({ success: true });
  } catch (error) {
    console.error("Error saving API key:", error);
    res.status(500).json({
      success: false,
      message: "Gagal menyimpan API key",
    });
  }
});

// Endpoint upload avatar
app.post(
  "/upload-avatar",
  requireAuthAPI,
  avatarUpload.single("avatar"),
  (req, res) => {
    try {
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

function scheduleStream(streamData, startTime, duration) {
  const streamKey = streamData.stream_key;
  const delayMs = startTime - Date.now();

  console.log(`Menjadwalkan streaming untuk ${streamKey} dalam ${delayMs} ms`);

  const timeout = setTimeout(async () => {
    console.log("start-schedule:", {
      videoPath: streamData.videoPath,
      audioPath: streamData.audioPath,
      rtmp_url: streamData.rtmp_url,
      bitrate: streamData.bitrate,
      fps: streamData.fps,
      resolution: streamData.resolution,
      loop: streamData.loop,
      audio_file: streamData.audio_file,
    });

    try {
      await new Promise((resolve, reject) => {
        database.updateStreamContainer(
          streamData.containerId,
          {
            is_streaming: 1,
          },
          (err) => {
            if (err) reject(err);
            resolve();
          }
        );
      });

      const command = ffmpeg(streamData.videoPath)
        .inputFormat("mp4")
        .inputOptions([
          "-re",
          ...(streamData.loop === "true" ? ["-stream_loop", "-1"] : []),
        ]);

      if (streamData.audio_file && streamData.audioPath) {
        command
          .input(streamData.audioPath)
          .inputOptions([
            "-re",
            ...(streamData.loop === "true" ? ["-stream_loop", "-1"] : []),
          ]);
      }

      const outputOptions = [
        `-r ${streamData.fps || 30}`,
        "-threads 2",
        '-x264-params "nal-hrd=cbr"',
        "-c:v libx264",
        "-preset veryfast",
        "-tune zerolatency",
        `-b:v ${streamData.bitrate}k`,
        `-maxrate ${streamData.bitrate}k`,
        `-bufsize ${streamData.bitrate * 2}k`,
        "-pix_fmt yuv420p",
        "-g 60",
        `-vf scale=${streamData.resolution}`,
        "-c:a aac",
        "-b:a 128k",
        "-ar 44100",
        "-f flv",
      ];

      if (streamData.audio_file && streamData.audioPath) {
        outputOptions.push(
          "-map 0:v:0", // video dari input video
          "-map 1:a:0" // audio dari input audio eksternal
        );
      } else {
        outputOptions.push(
          "-map 0:v:0", // video dari input video
          "-map 0:a?" // audio dari input video jika ada
        );
      }

      command.outputOptions(outputOptions);
      command.output(`${streamData.rtmp_url}/${streamData.stream_key}`);

      command.on("start", async (cmdLine) => {
        console.log("FFmpeg started:", cmdLine);
      });

      command.on("error", (err) => {
        if (err.message.includes("Exiting normally, received signal 15")) {
          console.log("Streaming dihentikan:", streamKey);
          return;
        }
        if (streamData.videoPath) {
          deleteFile(streamData.videoPath);
        }

        if (streamData.audio_file && streamData.audioFilePath) {
          deleteFile(streamData.audioPath);
        }
        console.error("FFmpeg error:", err);
      });

      command.on("end", () => {
        console.log("Scheduled stream ended:", streamKey);
        database.updateStreamContainer(
          streamData.containerId,
          { is_streaming: 0 },
          (err) => {
            if (err) console.error("Error updating database:", err);
            if (streamData.videoPath) {
              deleteFile(streamData.videoPath);
            }

            if (streamData.audio_file && streamData.audioFilePath) {
              deleteFile(streamData.audioPath);
            }
          }
        );
        streams[streamKey] = null;
        scheduledStreams.delete(streamKey);
      });

      if (duration) {
        setTimeout(() => {
          try {
            if (streams[streamKey] && streams[streamKey].process) {
              streams[streamKey].process.kill("SIGTERM");

              database.updateStreamContainer(
                streamData.containerId,
                {
                  is_streaming: 0,
                  auto_stopped: true,
                },
                (err) => {
                  if (err) console.error("Error updating stream status:", err);
                }
              );

              if (streamData.videoPath) {
                deleteFile(streamData.videoPath);
              }

              if (streamData.audio_file && streamData.audioFilePath) {
                deleteFile(streamData.audioPath);
              }
              delete streams[streamKey];
              scheduledStreams.delete(streamKey);
            }
          } catch (error) {
            console.error("Error stopping scheduled stream:", error);
          }
        }, duration);
      }

      streams[streamKey] = {
        process: command,
        startTime: Date.now(),
        containerId: streamData.containerId,
        videoPath: streamData.videoPath,
        audioPath: streamData.audioPath,
        audio_file: streamData.audio_file,
        duration: duration,
      };

      command.run();
      scheduledStreams.delete(streamKey);
    } catch (error) {
      console.error("Error starting scheduled stream:", error);
      scheduledStreams.delete(streamKey);
      database.updateStreamContainer(
        streamData.containerId,
        {
          is_streaming: 0,
        },
        (err) => {
          if (err) console.error("Error updating stream status:", err);
        }
      );
    }
  }, delayMs);

  scheduledStreams.set(streamKey, {
    timeout,
    startTime,
    duration,
    streamData,
  });
}

// Endpoint untuk membatalkan jadwal
app.post("/cancel-schedule/:streamKey", requireAuthAPI, async (req, res) => {
  const streamKey = req.params.streamKey;
  const scheduled = scheduledStreams.get(streamKey);

  if (scheduled) {
    try {
      clearTimeout(scheduled.timeout);

      await new Promise((resolve, reject) => {
        database.updateStreamContainer(
          scheduled.streamData.containerId,
          {
            is_streaming: 0,
          },
          (err) => {
            if (err) reject(err);
            resolve();
          }
        );
      });

      if (scheduled.streamData.videoPath) {
        try {
          await fs.promises.unlink(scheduled.streamData.videoPath);
          console.log("Video file deleted:", scheduled.streamData.videoPath);
        } catch (err) {
          console.error("Error deleting video file:", err);
        }
      }

      if (scheduled.streamData.audioPath) {
        try {
          await fs.promises.unlink(scheduled.streamData.audioPath);
          console.log("Audio file deleted:", scheduled.streamData.audioPath);
        } catch (err) {
          console.error("Error deleting audio file:", err);
        }
      }
      scheduledStreams.delete(streamKey);

      res.json({ success: true });
    } catch (error) {
      console.error("Error canceling schedule:", error);
      res.status(500).json({
        success: false,
        message: "Failed to cancel schedule",
      });
    }
  } else {
    res.status(404).json({
      success: false,
      message: "Jadwal tidak ditemukan",
    });
  }
});

// Endpoint untuk mendapatkan daftar jadwal
app.get("/scheduled-streams", requireAuthAPI, (req, res) => {
  const scheduledList = Array.from(scheduledStreams.entries()).map(
    ([key, data]) => ({
      stream_key: key,
      start_time: new Date(data.startTime).toISOString(),
      duration: data.duration,
      title: data.streamData.title,
    })
  );

  res.json({ schedules: scheduledList });
});

async function loadScheduledStreams() {
  try {
    const containers = await new Promise((resolve, reject) => {
      database.getStreamContainers((err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });

    containers
      .filter(
        (container) =>
          container.schedule_enabled === 1 &&
          container.schedule_start_enabled === 1 &&
          container.schedule_start &&
          new Date(container.schedule_start).getTime() > Date.now()
      )
      .forEach((container) => {
        scheduleStream(
          {
            videoPath: path.join(
              __dirname,
              "uploads",
              container.stream_file_video
            ),
            audioPath: container.stream_file_audio
              ? path.join(__dirname, "uploads", container.stream_file_audio)
              : null,
            stream_key: container.stream_key,
            rtmp_url: container.stream_url,
            containerId: container.id,
            fps: container.fps,
            bitrate: container.bitrate,
            resolution: container.resolution,
            loop: container.loop_enabled === 1 ? "true" : "false",
            audio_file: container.audio_enabled === 1 ? "true" : "false",
          },
          new Date(container.schedule_start).getTime(),
          container.schedule_duration
            ? container.schedule_duration * 60 * 1000
            : null
        );
      });
  } catch (error) {
    console.error("Error loading scheduled streams:", error);
  }
}

async function loadActiveStreams() {
  try {
    const containers = await new Promise((resolve, reject) => {
      database.getActiveStreamContainers((err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });

    for (const container of containers) {
      const streamKey = container.stream_key;
      streams[streamKey] = {
        process: null,
        startTime: Date.now(),
        containerId: container.id,
        videoPath: path.join(__dirname, "uploads", container.stream_file_video),
        audioPath: container.stream_file_audio
          ? path.join(__dirname, "uploads", container.stream_file_audio)
          : null,
        audio_file: container.audio_enabled === 1 ? "true" : "false",
        duration: container.schedule_duration
          ? container.schedule_duration * 60 * 1000
          : null,
      };
    }

    console.log("Active streams loaded:", Object.keys(streams));
  } catch (err) {
    console.error("Failed to load active streams:", err);
  }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(
    `\x1b[32mStreamApp Running\x1b[0m\nAccess app on \x1b[34mhttp://${ipAddress}:${PORT}\x1b[0m`
  );
  loadScheduledStreams();
  loadActiveStreams();
});
