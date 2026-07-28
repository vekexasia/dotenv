// barrel
import devissue from "./pi-ext-workflows/develop-issues.js";
import revloop from "./pi-ext-workflows/review-loop.js";
import tdd from "./pi-ext-workflows/tdd.js";

export default function () {
  devissue();
  revloop();
  tdd();
}
