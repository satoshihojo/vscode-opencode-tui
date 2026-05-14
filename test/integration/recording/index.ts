import * as path from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
  });

  mocha.addFile(path.resolve(__dirname, "./real-opencode-recording.integration.test.js"));

  return new Promise((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} recording integration test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}
