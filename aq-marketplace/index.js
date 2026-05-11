#!/usr/bin/env node
'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const os      = require('os');

// ── Local paths ──────────────────────────────────────────────────────────
const ROOT          = path.resolve(__dirname, '..');
const LOCAL_MKT     = path.join(__dirname, 'marketplace.json');
const MCP_SERVER_PY = path.join(__dirname, 'mcp_server.py').replace(/\\/g, '/');
const PKG_SKILLS    = path.join(__dirname, 'skills');   // bundled skills inside npm package
const PKG_AGENTS    = path.join(__dirname, 'agents');   // bundled agents inside npm package
const LOCAL_SKILLS  = path.join(ROOT, 'IPR001360_Prompt_Library_MCP',
                       'prompt_library_mcp_server', 'resources', 'claude');
const LOCAL_AGENTS  = path.join(ROOT, 'IPR001360_Prompt_Library_MCP',
                       'prompt_library_mcp_server', 'resources', 'agents');

// ── User config (~/.aq-marketplace/config.json) ────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), '.aq-marketplace');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CACHE_FILE  = path.join(CONFIG_DIR, 'marketplace.cache.json');
const SKILLS_CACHE_FILE = path.join(CONFIG_DIR, 'skills.cache.json');

// ── Global Amazon Q directories (under ~/.aws/amazonq/) ───────────────────
const AWS_PROMPTS_DIR = path.join(os.homedir(), '.aws', 'amazonq', 'prompts');
const AWS_RULES_DIR   = path.join(os.homedir(), '.aws', 'amazonq', 'rules');

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  catch { return {}; }
}

function writeConfig(cfg) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── HTTP fetch (no external deps) ─────────────────────────────────────────
function fetchUrl(url, token) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { headers: token ? { Authorization: `Bearer ${token}` } : {} };
    mod.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, token).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Convert github.com URL → raw.githubusercontent.com base ───────────────
function toRawBase(repoUrl) {
  // https://github.com/org/repo  →  https://raw.githubusercontent.com/org/repo/main/
  const m = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/main/`;
  // Already a raw base or custom URL — strip trailing slash + add /
  return repoUrl.replace(/\/?$/, '/');
}

function toRawMarketplaceUrl(repoUrl) {
  return toRawBase(repoUrl) + 'aq-marketplace/marketplace.json';
}

// ── Load marketplace (remote cache first, then local file) ─────────────────
function load() {
  const cfg = readConfig();
  // Remote mode: use cached copy
  if (cfg.remote_url && fs.existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch { /* fall through to local */ }
  }
  // Local mode
  if (!fs.existsSync(LOCAL_MKT)) {
    console.error(
      'No marketplace found.\n' +
      '  Local : marketplace.json not found\n' +
      '  Remote: run "aq-marketplace connect <repo-url>" first'
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(LOCAL_MKT, 'utf8').replace(/^﻿/, ''));
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function isRemoteMode() {
  return !!readConfig().remote_url;
}

// ── Install helpers ────────────────────────────────────────────────────────
// ── Fetch and cache all skills from the hosted server ─────────────────────
async function ensureSkillsCache(serverUrl, token) {
  if (fs.existsSync(SKILLS_CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(SKILLS_CACHE_FILE, 'utf8')); }
    catch { /* re-fetch */ }
  }
  process.stdout.write('Fetching skills from server... ');
  const raw = await fetchUrl(`${serverUrl}/mcp/claude/download_skills`, token);
  const data = JSON.parse(raw);
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(SKILLS_CACHE_FILE, JSON.stringify(data), 'utf8');
  console.log(`OK (${data.count} skills)`);
  return data;
}

async function copyOrFetch(relPath, destFile, rawBase) {
  if (rawBase) {
    // Remote GitHub raw mode (marketplace.json hosted on GitHub)
    const url = rawBase + relPath.replace(/\\/g, '/');
    try {
      const content = await fetchUrl(url);
      fs.writeFileSync(destFile, content, 'utf8');
      return true;
    } catch (e) {
      process.stderr.write(`  WARN: ${e.message}\n`);
      return false;
    }
  }
  // Server mode: skills are in the cache loaded by cmdInstall
  return false; // handled directly in cmdInstall
}

// ── Commands ───────────────────────────────────────────────────────────────

// bundle — copy skills from source into the npm package (run once before publishing)
function cmdBundle() {
  if (!fs.existsSync(LOCAL_SKILLS)) {
    console.error(`Source skills not found at: ${LOCAL_SKILLS}`);
    process.exit(1);
  }
  ensureDir(PKG_SKILLS);
  ensureDir(PKG_AGENTS);

  // Copy skills
  let skills = 0;
  for (const skillDir of fs.readdirSync(LOCAL_SKILLS)) {
    const src = path.join(LOCAL_SKILLS, skillDir, 'SKILL.md');
    if (!fs.existsSync(src)) continue;
    const dest = path.join(PKG_SKILLS, skillDir);
    ensureDir(dest);
    fs.copyFileSync(src, path.join(dest, 'SKILL.md'));
    skills++;
  }

  // Copy agents
  let agents = 0;
  if (fs.existsSync(LOCAL_AGENTS)) {
    for (const f of fs.readdirSync(LOCAL_AGENTS)) {
      const destName = f.replace('.agent.md', '.md');
      fs.copyFileSync(path.join(LOCAL_AGENTS, f), path.join(PKG_AGENTS, destName));
      agents++;
    }
  }

  console.log(`\nBundled into npm package:`);
  console.log(`  Skills : ${PKG_SKILLS}  (${skills} folders)`);
  console.log(`  Agents : ${PKG_AGENTS}  (${agents} files)`);
  console.log('\nNow run: npm install -g .  to reinstall with bundled skills.');
}


async function cmdSetServer(serverUrl, token) {
  if (!serverUrl) {
    console.error('Usage: aq-marketplace set-server <server-url>');
    console.error('Example: aq-marketplace set-server http://your-server:8000');
    process.exit(1);
  }
  // Verify server is reachable
  process.stdout.write(`Connecting to server ${serverUrl} ... `);
  try {
    const raw = await fetchUrl(`${serverUrl}/health`);
    const health = JSON.parse(raw);
    console.log(`OK (${health.status})`);
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  }
  if (fs.existsSync(SKILLS_CACHE_FILE)) fs.unlinkSync(SKILLS_CACHE_FILE);
  writeConfig({ ...readConfig(), server_url: serverUrl, token: token || null });
  console.log(`\nServer configured: ${serverUrl}`);
  if (!token) console.log('Run "aq-marketplace login" to authenticate.');
  else console.log('Run "aq-marketplace install <plugin-id>" to install plugins.');
}

// login — fetches auth config from server, opens browser for OAuth, saves token
async function cmdLogin() {
  const cfg = readConfig();
  if (!cfg.server_url) {
    console.error('No server configured. Run "aq-marketplace set-server <url>" first.');
    process.exit(1);
  }

  // Step 1: fetch auth discovery from server
  process.stdout.write('Fetching auth config from server... ');
  let discovery;
  try {
    const raw = await fetchUrl(`${cfg.server_url}/auth/discovery`);
    discovery = JSON.parse(raw);
    console.log('OK');
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  }

  // Step 2: if auth is disabled on server, no token needed
  if (!discovery.auth_enabled) {
    writeConfig({ ...cfg, token: null });
    console.log('\nServer has auth disabled — no login required.');
    console.log('Run "aq-marketplace install <plugin-id>" to install plugins.');
    return;
  }

  // Step 3: guide user to get token from their OAuth provider
  console.log(`\nAuth provider : ${discovery.auth_provider}`);
  console.log(`Token URL     : ${discovery.token_url}`);
  console.log(`Client ID     : ${discovery.client_id}`);
  console.log('');
  console.log('To get your access token:');

  if (discovery.auth_provider === 'keycloak') {
    console.log(`  curl -s -X POST "${discovery.token_url}" \\`);
    console.log(`    -d "client_id=${discovery.client_id}" \\`);
    console.log(`    -d "username=<your-username>" \\`);
    console.log(`    -d "password=<your-password>" \\`);
    console.log(`    -d "grant_type=password" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).access_token))"`)
  } else {
    console.log(`  Use your organization's SSO portal to get a bearer token for:`);
    console.log(`  ${discovery.token_url}`);
  }

  console.log('');
  console.log('Then save it with:');
  console.log('  aq-marketplace set-token <paste-token-here>');
}

// set-token <token> — save token without re-running set-server
function cmdSetToken(token) {
  if (!token) {
    console.error('Usage: aq-marketplace set-token <token>');
    process.exit(1);
  }
  const cfg = readConfig();
  if (!cfg.server_url) {
    console.error('No server configured. Run "aq-marketplace set-server <url>" first.');
    process.exit(1);
  }
  if (fs.existsSync(SKILLS_CACHE_FILE)) fs.unlinkSync(SKILLS_CACHE_FILE);
  writeConfig({ ...cfg, token });
  console.log('\nToken saved. Run "aq-marketplace install <plugin-id>" to install plugins.');
}

// connect <repo-url>
async function cmdConnect(repoUrl) {
  if (!repoUrl) {
    console.error('Usage: aq-marketplace connect <repo-url>');
    console.error('Example: aq-marketplace connect https://github.com/cognizant/prompt-library-mcp');
    process.exit(1);
  }
  const rawUrl = toRawMarketplaceUrl(repoUrl);
  console.log(`Connecting to: ${rawUrl}`);
  process.stdout.write('Fetching marketplace... ');
  let data;
  try {
    data = await fetchUrl(rawUrl);
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  }
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CACHE_FILE, data, 'utf8');
  const mkt = JSON.parse(data.replace(/^﻿/, ''));
  const rawBase = toRawBase(repoUrl);
  writeConfig({ remote_url: repoUrl, raw_base: rawBase, last_updated: new Date().toISOString() });
  console.log('OK');
  console.log(`\nConnected to: ${mkt.name}`);
  console.log(`  Plugins: ${mkt.total_plugins}  |  Skills: ${mkt.total_skills}  |  Agents: ${mkt.total_agents}`);
  console.log(`  Cache  : ${CACHE_FILE}`);
  console.log('\nRun "aq-marketplace list" to browse plugins.');
}

// update
async function cmdUpdate() {
  const cfg = readConfig();
  if (!cfg.remote_url) {
    console.error('Not connected to a remote marketplace.\nRun "aq-marketplace connect <repo-url>" first.');
    process.exit(1);
  }
  const rawUrl = toRawMarketplaceUrl(cfg.remote_url);
  process.stdout.write(`Updating from ${rawUrl} ... `);
  try {
    const data = await fetchUrl(rawUrl);
    fs.writeFileSync(CACHE_FILE, data, 'utf8');
    const mkt = JSON.parse(data.replace(/^﻿/, ''));
    writeConfig({ ...cfg, last_updated: new Date().toISOString() });
    console.log('OK');
    console.log(`  Plugins: ${mkt.total_plugins}  |  Skills: ${mkt.total_skills}  |  Agents: ${mkt.total_agents}`);
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  }
}

function cmdStatus() {
  const cfg = readConfig();
  if (cfg.server_url) {
    console.log(`\nMode         : server`);
    console.log(`Server URL   : ${cfg.server_url}`);
    console.log(`Token        : ${cfg.token ? 'configured' : 'not set'}`);
    console.log(`Skills cache : ${fs.existsSync(SKILLS_CACHE_FILE) ? SKILLS_CACHE_FILE : 'not cached yet'}`);
  } else if (cfg.remote_url) {
    const mkt = load();
    console.log(`\nMode         : remote repo`);
    console.log(`Repo         : ${cfg.remote_url}`);
    console.log(`Last updated : ${cfg.last_updated}`);
    console.log(`Marketplace  : ${mkt.name}  (${mkt.total_plugins} plugins)`);
  } else {
    const local = fs.existsSync(LOCAL_MKT) ? LOCAL_MKT : 'not found';
    console.log(`\nMode   : local`);
    console.log(`Source : ${local}`);
    console.log('\nOptions:');
    console.log('  aq-marketplace set-server <url> [token]   — use hosted server');
    console.log('  aq-marketplace connect <repo-url>         — use GitHub repo');
  }
  console.log('');
}

function cmdList() {
  const m = load();
  const src = isRemoteMode() ? `remote: ${readConfig().remote_url}` : `local: ${LOCAL_MKT}`;
  console.log(`\n${m.name}`);
  console.log(`Source: ${src}\n`);
  console.log(`Plugins: ${m.total_plugins}  |  Skills: ${m.total_skills}  |  Agents: ${m.total_agents}\n`);
  console.log('ID'.padEnd(32) + 'Name'.padEnd(38) + 'Skills  Agents');
  console.log('─'.repeat(82));
  for (const p of m.plugins) {
    console.log(
      p.id.padEnd(32) +
      p.name.padEnd(38) +
      String(p.skills.length).padStart(4) + '    ' +
      String(p.agents.length).padStart(4)
    );
  }
  console.log('');
}

function cmdSearch(query) {
  if (!query) { console.error('Usage: aq-marketplace search <query>'); process.exit(1); }
  const q = query.toLowerCase();
  const results = load().plugins.filter(p =>
    p.id.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.tags.some(t => t.includes(q)) ||
    p.skills.some(s => s.id.toLowerCase().includes(q))
  );
  if (!results.length) { console.log(`\nNo plugins found for "${query}"\n`); return; }
  console.log(`\nSearch results for "${query}":\n`);
  for (const p of results) {
    console.log(`  ${p.id}`);
    console.log(`    ${p.name}  (${p.skills.length} skills, ${p.agents.length} agents)`);
    console.log(`    ${p.description}`);
    console.log(`    Tags: ${p.tags.join(', ')}`);
    console.log('');
  }
}

function cmdInfo(pluginId) {
  if (!pluginId) { console.error('Usage: aq-marketplace info <plugin-id>'); process.exit(1); }
  const plugin = load().plugins.find(p => p.id === pluginId);
  if (!plugin) { console.error(`Plugin "${pluginId}" not found.`); process.exit(1); }
  console.log(`\n${plugin.name}  (${plugin.id})`);
  console.log(`\n${plugin.description}`);
  console.log(`\nTags: ${plugin.tags.join(', ')}`);
  console.log(`\nSkills (${plugin.skills.length}):`);
  for (const s of plugin.skills) console.log(`  - ${s.id}`);
  if (plugin.agents.length) {
    console.log(`\nAgents (${plugin.agents.length}):`);
    for (const a of plugin.agents) console.log(`  - @${a.id}  (${a.file})`);
  }
  console.log('');
}

// Generate the plugin-level wrapper agent so it appears under @ in Amazon Q
function generatePluginAgent(plugin) {
  const skillNames = plugin.skills.map(s => `- ${s.id}`).join('\n');
  const builtinAgents = plugin.agents.length
    ? '\n## Built-in Agents\n' + plugin.agents.map(a => `- @${a.id}`).join('\n')
    : '';
  const examples = getExamples(plugin.id);
  const howToUse = examples
    ? `Describe your task and this plugin will apply the most relevant skill. Examples:\n${examples}`
    : `Describe your task and this plugin will apply the most relevant skill.`;

  return `\`\`\`chatagent
---
description: '[Marketplace Plugin] ${plugin.name} — ${plugin.skills.length} skills. ${plugin.description.replace(/'/g, "\\'")}'
tools: []
---

# ${plugin.name}

${plugin.description}

**Tags:** ${plugin.tags.join(', ')}
**Skills:** ${plugin.skills.length}${plugin.agents.length ? `  |  **Agents:** ${plugin.agents.length}` : ''}

## How to use

${howToUse}
${builtinAgents}

## Available Skills (${plugin.skills.length})

${skillNames}
\`\`\`
`;
}

function getExamples(pluginId) {
  const examples = {
    'pl-sdlc':              '- "Create unit test cases for this method"\n- "Generate a deployment script"\n- "Create a user story for this feature"',
    'pl-rest-api':          '- "Create a Spring Boot REST API for user management"\n- "Generate a microservice controller class"',
    'pl-spring-boot-codegen':'- "Create a JPA entity class for Orders table"\n- "Add Spring Data JPA repository for User"',
    'pl-react-ui':          '- "Create a React component with useState and useEffect"\n- "Add a Redux store for cart management"',
    'pl-angular-ui':        '- "Create an Angular service for HTTP calls"\n- "Add Angular routing with lazy loading"',
    'pl-tech-migration':    '- "Migrate this Struts action class to Spring Boot controller"\n- "Convert AngularJS controller to Angular component"',
    'pl-tech-upgrade':      '- "Upgrade this Spring Boot 1.x project to 2.x"\n- "Migrate Java 8 code to use Java 17 features"',
    'pl-testing':           '- "Generate unit tests for this service class"\n- "Create a BDD feature file for login flow"',
    'pl-cloud-aws':         '- "Create an S3 bucket with versioning enabled"\n- "Write a Lambda function to process SQS messages"',
    'pl-cloud-azure':       '- "Create an Azure Function for blob storage trigger"\n- "Set up Azure SQL Database connection"',
    'pl-cloud-gcp':         '- "Create a GCP Cloud Function for Pub/Sub"\n- "Set up Cloud Storage bucket"',
    'pl-cicd':              '- "Create a GitHub Actions workflow for Maven build"\n- "Generate a Jenkins pipeline for Docker image push"',
    'pl-security':          '- "Add JWT authentication to this Spring Boot app"\n- "Fix SQL injection vulnerability in this query"',
    'pl-database':          '- "Create a stored procedure for monthly report"\n- "Write a JDBC query to fetch paginated results"',
    'pl-code-quality':      '- "Add Javadoc comments to this class"\n- "Generate a Mermaid sequence diagram for this flow"',
    'pl-design-patterns':   '- "Implement Factory pattern for payment processors"\n- "Apply Builder pattern to this config class"',
    'pl-3rd-party-libs':    '- "Use Jackson to serialize this object to JSON"\n- "Add Guava caching to this service"',
    'pl-dotnet-webdev':     '- "Create a Blazor Server app with authentication"\n- "Build a SignalR hub for real-time notifications"',
  };
  return examples[pluginId] || '';
}

async function cmdInstall(pluginId) {
  if (!pluginId) { console.error('Usage: aq-marketplace install <plugin-id>'); process.exit(1); }
  const plugin = load().plugins.find(p => p.id === pluginId);
  if (!plugin) { console.error(`Plugin "${pluginId}" not found. Run "aq-marketplace list".`); process.exit(1); }

  ensureDir(AWS_RULES_DIR);
  ensureDir(AWS_PROMPTS_DIR);

  const cfg = readConfig();
  console.log(`\nInstalling ${plugin.name} (${plugin.skills.length} skills, ${plugin.agents.length} agents)...`);

  let skills = 0, agents = 0, missing = 0;

  if (cfg.server_url) {
    // ── Server mode: fetch skills from hosted server ──────────────────────
    const skillsData = await ensureSkillsCache(cfg.server_url, cfg.token);
    // Build a lookup map: skill_name → content
    const skillMap = {};
    for (const s of (skillsData.skills || [])) {
      const skillFile = s.files && s.files.find(f => f.filename === 'SKILL.md');
      if (skillFile) skillMap[s.skill_name] = skillFile.content;
    }

    for (const skill of plugin.skills) {
      const content = skillMap[skill.id];
      if (content) {
        const destDir = path.join(AWS_RULES_DIR, skill.id);
        ensureDir(destDir);
        fs.writeFileSync(path.join(destDir, 'SKILL.md'), content, 'utf8');
        skills++;
      } else {
        missing++;
      }
    }

    // Agents from server
    if (plugin.agents.length) {
      try {
        const raw = await fetchUrl(`${cfg.server_url}/mcp/prompts/download_default_prompts`, cfg.token);
        const agentsData = JSON.parse(raw);
        const agentMap = {};
        for (const f of (agentsData.files || [])) agentMap[f.filename] = f.content;
        for (const agent of plugin.agents) {
          const content = agentMap[`${agent.id}.agent.md`];
          if (content) {
            fs.writeFileSync(path.join(AWS_PROMPTS_DIR, agent.id + '.agent.md'), content, 'utf8');
            agents++;
          } else missing++;
        }
      } catch (e) {
        process.stderr.write(`  WARN: Could not fetch agents: ${e.message}\n`);
      }
    }

  } else {
    // ── GitHub raw mode: fetch from repo ─────────────────────────────────
    const rawBase = cfg.raw_base || null;
    if (!rawBase) {
      console.error('No server_url or repo configured. Run "aq-marketplace connect" first.');
      process.exit(1);
    }
    for (const skill of plugin.skills) {
      const destDir = path.join(AWS_RULES_DIR, skill.id);
      ensureDir(destDir);
      const ok = await copyOrFetch(skill.file, path.join(destDir, 'SKILL.md'), rawBase);
      ok ? skills++ : missing++;
    }
    for (const agent of plugin.agents) {
      const destFile = path.join(AWS_PROMPTS_DIR, agent.id + '.agent.md');
      const ok = await copyOrFetch(agent.file, destFile, rawBase);
      ok ? agents++ : missing++;
    }
  }

  // Plugin wrapper → ~/.aws/amazonq/prompts/ (makes @<plugin-id> appear in @ dropdown)
  fs.writeFileSync(path.join(AWS_PROMPTS_DIR, plugin.id + '.agent.md'), generatePluginAgent(plugin), 'utf8');

  console.log(`\nInstalled: ${plugin.name}`);
  console.log(`  Skills → ~/.aws/amazonq/rules/  (${skills} files)`);
  console.log(`  Agents → ~/.aws/amazonq/prompts/  (${agents + 1} files)`);
  if (missing) console.log(`  Skipped: ${missing} source files not found`);
  console.log(`\nNow available in Amazon Q (type @):`);
  console.log(`  @${plugin.id}`);
  for (const a of plugin.agents) console.log(`  @${a.id}`);
  console.log('\nRestart Amazon Q to pick up changes.\n');
}

async function cmdInstallAll() {
  const m = load();
  console.log(`\nInstalling all ${m.total_plugins} plugins...\n`);
  for (const p of m.plugins) {
    await cmdInstall(p.id);
  }
}

function cmdUninstall(pluginId) {
  if (!pluginId) { console.error('Usage: aq-marketplace uninstall <plugin-id>'); process.exit(1); }
  const plugin = load().plugins.find(p => p.id === pluginId);
  if (!plugin) { console.error(`Plugin "${pluginId}" not found.`); process.exit(1); }

  let removed = 0;

  // Remove skills from global rules dir
  for (const skill of plugin.skills) {
    const d = path.join(AWS_RULES_DIR, skill.id);
    if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true }); removed++; }
  }
  // Remove dedicated agents from global prompts dir
  for (const agent of plugin.agents) {
    const f = path.join(AWS_PROMPTS_DIR, agent.id + '.md');
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed++; }
  }
  // Remove plugin wrapper from global prompts dir
  const wrapper = path.join(AWS_PROMPTS_DIR, plugin.id + '.agent.md');
  if (fs.existsSync(wrapper)) { fs.unlinkSync(wrapper); removed++; }

  console.log(`\nUninstalled: ${plugin.name}  (${removed} files removed)\n`);
}

function cmdInit(targetDir) {
  const base       = path.resolve(targetDir || process.cwd());
  const amazonqDir = path.join(base, '.amazonq');
  ensureDir(amazonqDir);

  const mcpFile   = path.join(amazonqDir, 'mcp.json');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const mcpConfig = {
    mcpServers: {
      "prompt-library": {
        command: pythonCmd,
        args: [MCP_SERVER_PY],
        env: {}
      }
    }
  };
  fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2));

  console.log(`\nMCP server registered in Amazon Q:`);
  console.log(`  Config : ${mcpFile}`);
  console.log(`  Server : ${MCP_SERVER_PY}`);
  console.log(`\nMCP tools available inside "q chat":`);
  console.log(`  list_plugins        — list all marketplace plugins`);
  console.log(`  search_plugins      — search plugins by keyword`);
  console.log(`  get_skill           — retrieve a specific skill`);
  console.log(`  list_plugin_skills  — list all skills in a plugin`);
  console.log(`  marketplace_summary — high-level overview`);
  console.log(`\nRestart "q chat" to activate.\n`);
}

// ── Dispatch ───────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

(async () => {
  switch (cmd) {
    case 'bundle':     cmdBundle();                                        break;
    case 'set-server': await cmdSetServer(args[0]);                       break;
    case 'login':      await cmdLogin();                                   break;
    case 'set-token':  cmdSetToken(args[0]);                              break;
    case 'connect':   await cmdConnect(args[0]);                          break;
    case 'update':    await cmdUpdate();                                   break;
    case 'status':    cmdStatus();                                         break;
    case 'list':      cmdList();                                           break;
    case 'search':    cmdSearch(args[0]);                                  break;
    case 'info':      cmdInfo(args[0]);                                    break;
    case 'install':
      if (args[0] === '--all') await cmdInstallAll();
      else await cmdInstall(args[0]);
      break;
    case 'uninstall': cmdUninstall(args[0]);                              break;
    case 'init':      cmdInit(args[0]);                                    break;
    default:
      console.log(`
Cognizant Prompt Library — Amazon Q Marketplace CLI

USAGE
  aq-marketplace <command> [options]

REPO SETUP
  connect  <repo-url>               Connect to a GitHub marketplace repo
  update                            Refresh marketplace from remote repo
  status                            Show current connection status

BROWSING
  list                              List all available plugins
  search   <query>                  Search by name, tag, or skill ID
  info     <plugin-id>              Full details for a plugin

INSTALL
  install  <plugin-id>              Install plugin skills + agents
  install  --all                    Install ALL plugins
  uninstall <plugin-id>             Remove an installed plugin

MCP SETUP
  init     [dir]                    Register stdio MCP server in Amazon Q

EXAMPLES — End-to-end workflow
  aq-marketplace connect https://github.com/your-org/your-repo
  aq-marketplace list
  aq-marketplace install demo-utilities
  aq-marketplace init

IN AMAZON Q CHAT (after install — type @ in chat)
  @demo-utilities             plugin wrapper (lists skills)
  @demo-greeter               agent

IN AMAZON Q CHAT (after init — MCP tools)
  "list all prompt library plugins"
  "search for AWS skills"
  "show me details of pl-sdlc"
`);
  }
})();
