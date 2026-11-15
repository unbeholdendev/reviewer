import { agent } from "./agent";
import { createApp } from "./app";
import { forgejo } from "./forgejo";
import { git } from "./git";

export default createApp({ forgejo, git, agent });
