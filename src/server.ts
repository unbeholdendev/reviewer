import { createApp } from "./app";
import { agent } from "./agent";
import { forgejo } from "./forgejo";
import { git } from "./git";

export default createApp({ forgejo, git, agent });
