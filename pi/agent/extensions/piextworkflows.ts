// barrel
import fetchdetails from "./pi-ext-workflows/fetch-issue-details.js";
import revloop from "./pi-ext-workflows/review-loop.js";
import seqissues from "./pi-ext-workflows/seq-issues.js";
import tdd from "./pi-ext-workflows/tdd.js";

export default function () {
  fetchdetails();
  revloop();
  seqissues();
  tdd();
}
