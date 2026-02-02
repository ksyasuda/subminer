/*
 * mpv-yomitan - Yomitan integration for mpv
 * Copyright (C) 2024 sudacode
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export class MediaGenerator {
  private tempDir: string;

  constructor(tempDir?: string) {
    this.tempDir = tempDir || path.join(os.tmpdir(), "mpv-yomitan-media");
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async generateAudio(
    videoPath: string,
    startTime: number,
    endTime: number,
    padding: number = 0.5,
  ): Promise<Buffer> {
    const start = Math.max(0, startTime - padding);
    const duration = endTime - startTime + 2 * padding;

    return new Promise((resolve, reject) => {
      const outputPath = path.join(this.tempDir, `audio_${Date.now()}.mp3`);

      execFile(
        "ffmpeg",
        [
          "-ss",
          start.toString(),
          "-t",
          duration.toString(),
          "-i",
          videoPath,
          "-vn",
          "-acodec",
          "libmp3lame",
          "-q:a",
          "2",
          "-ar",
          "44100",
          "-y",
          outputPath,
        ],
        { timeout: 30000 },
        (error) => {
          if (error) {
            reject(new Error(`FFmpeg audio generation failed: ${error.message}`));
            return;
          }

          try {
            const data = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath);
            resolve(data);
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  }

  async generateScreenshot(
    videoPath: string,
    timestamp: number,
    format: "jpg" | "png" | "webp" = "jpg",
  ): Promise<Buffer> {
    const ext = format === "webp" ? "webp" : format === "png" ? "png" : "jpg";
    const codecMap: Record<string, string> = {
      jpg: "mjpeg",
      png: "png",
      webp: "webp",
    };

    return new Promise((resolve, reject) => {
      const outputPath = path.join(this.tempDir, `screenshot_${Date.now()}.${ext}`);

      execFile(
        "ffmpeg",
        [
          "-ss",
          timestamp.toString(),
          "-i",
          videoPath,
          "-vframes",
          "1",
          "-c:v",
          codecMap[format],
          "-q:v",
          "2",
          "-y",
          outputPath,
        ],
        { timeout: 30000 },
        (error) => {
          if (error) {
            reject(new Error(`FFmpeg screenshot generation failed: ${error.message}`));
            return;
          }

          try {
            const data = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath);
            resolve(data);
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  }

  async generateAnimatedImage(
    videoPath: string,
    startTime: number,
    endTime: number,
    padding: number = 0.5,
  ): Promise<Buffer> {
    const start = Math.max(0, startTime - padding);
    const duration = endTime - startTime + 2 * padding;

    return new Promise((resolve, reject) => {
      const outputPath = path.join(this.tempDir, `animation_${Date.now()}.avif`);

      execFile(
        "ffmpeg",
        [
          "-ss",
          start.toString(),
          "-t",
          duration.toString(),
          "-i",
          videoPath,
          "-vf",
          "fps=10,scale=640:-1",
          "-c:v",
          "libaom-av1",
          "-cpu-used",
          "8",
          "-y",
          outputPath,
        ],
        { timeout: 60000 },
        (error) => {
          if (error) {
            reject(new Error(`FFmpeg animation generation failed: ${error.message}`));
            return;
          }

          try {
            const data = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath);
            resolve(data);
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  }

  cleanup(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error("Failed to cleanup media generator temp directory:", err);
    }
  }
}
