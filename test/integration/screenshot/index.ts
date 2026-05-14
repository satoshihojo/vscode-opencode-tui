import * as path from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
  });

  mocha.addFile(path.resolve(__dirname, "./marketplace-screenshot.integration.test.js"));

  return new Promise((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} screenshot integration test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}
