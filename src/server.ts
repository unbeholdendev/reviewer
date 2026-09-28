import { createApp } from "./app";
import { claude } from "./claude";
import { forgejo } from "./forgejo";
import { git } from "./git";

export default createApp({ forgejo, git, claude });
