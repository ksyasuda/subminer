/*
  mpv-yomitan - Yomitan integration for mpv
  Copyright (C) 2024 sudacode

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { execSync } from "child_process";
import { BaseWindowTracker } from "./base-tracker";

export class MacOSWindowTracker extends BaseWindowTracker {
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.pollInterval = setInterval(() => this.pollGeometry(), 250);
    this.pollGeometry();
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private pollGeometry(): void {
    try {
      const processNames = ["mpv", "MPV", "org.mpv.mpv"];
      let geometry = null;

      for (const processName of processNames) {
        try {
          const script = `
            tell application "System Events"
              tell process "${processName}"
                if exists window 1 then
                  set windowPos to position of window 1
                  set windowSize to size of window 1
                  return (item 1 of windowPos) & "," & (item 2 of windowPos) & "," & (item 1 of windowSize) & "," & (item 2 of windowSize)
                else
                  return "not-found"
                end if
              end tell
            end tell
          `;

          const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
            encoding: "utf-8",
          }).trim();

          if (result && result !== "not-found") {
            const parts = result.split(",");
            if (parts.length === 4) {
              geometry = {
                x: parseInt(parts[0], 10),
                y: parseInt(parts[1], 10),
                width: parseInt(parts[2], 10),
                height: parseInt(parts[3], 10),
              };
              break;
            }
          }
        } catch {
          continue;
        }
      }

      this.updateGeometry(geometry);
    } catch (err) {
      this.updateGeometry(null);
    }
  }
}
