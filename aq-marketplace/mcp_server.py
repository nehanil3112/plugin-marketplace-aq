#!/usr/bin/env python3
"""
Standalone stdio MCP server for the Cognizant Prompt Library Marketplace.

Amazon Q Developer loads this via .amazonq/mcp.json.
Skills are bundled inside the npm package under skills/ folder.
No external server or auth needed.

Tools exposed to Amazon Q chat:
  - list_plugins       : browse the marketplace catalog
  - search_plugins     : search by keyword
  - list_plugin_skills : see all skills in a plugin
  - install_plugin     : install a plugin to ~/.aws/amazonq/
  - uninstall_plugin   : remove an installed plugin
  - marketplace_summary: high-level overview
"""

import json
import os
import shutil
import sys
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
_HERE       = Path(__file__).parent
MARKETPLACE = _HERE / "marketplace.json"
SKILLS_BASE = _HERE / "skills"                    # c:\mcp_project\aq-marketplace\skills\
AGENTS_BASE = _HERE / "agents"                    # c:\mcp_project\aq-marketplace\agents\

# Amazon Q global folders
AQ_RULES_DIR   = Path.home() / ".aws" / "amazonq" / "rules"
AQ_PROMPTS_DIR = Path.home() / ".aws" / "amazonq" / "prompts"

# ── MCP setup ──────────────────────────────────────────────────────────────
try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    print("ERROR: 'mcp' package not installed. Run: pip install mcp", file=sys.stderr)
    sys.exit(1)

mcp = FastMCP(
    name="prompt-library",
    description=(
        "Cognizant Prompt Library Marketplace — "
        "1083 skills and 6 agents covering SDLC, REST APIs, "
        "cloud (AWS/Azure/GCP), migrations, testing, security, and more."
    )
)


# ── Helpers ────────────────────────────────────────────────────────────────
def _load_marketplace() -> dict:
    if not MARKETPLACE.exists():
        raise FileNotFoundError(f"marketplace.json not found at {MARKETPLACE}")
    return json.loads(MARKETPLACE.read_text(encoding="utf-8"))


def _get_plugin(plugin_id: str) -> dict | None:
    return next((p for p in _load_marketplace()["plugins"] if p["id"] == plugin_id), None)


def _generate_wrapper(plugin: dict) -> str:
    """Generate the @<plugin-id> prompt wrapper that appears in Amazon Q @ dropdown."""
    skill_list = "\n".join(f"- {s['id']}" for s in plugin["skills"])
    agent_list = ("\n## Agents\n" + "\n".join(f"- @{a['id']}" for a in plugin["agents"])) \
        if plugin["agents"] else ""
    return (
        f"---\n"
        f"name: {plugin['id']}\n"
        f"description: \"[Marketplace Plugin] {plugin['name']} — "
        f"{len(plugin['skills'])} skills. {plugin['description']}\"\n"
        f"---\n\n"
        f"# {plugin['name']}\n\n"
        f"{plugin['description']}\n\n"
        f"**Tags:** {', '.join(plugin['tags'])}\n\n"
        f"## Available Skills\n\n{skill_list}\n"
        f"{agent_list}\n"
    )


# ── MCP Tools ──────────────────────────────────────────────────────────────

@mcp.tool()
def list_plugins() -> str:
    """List all available plugins in the Prompt Library Marketplace."""
    data = _load_marketplace()
    lines = [
        f"# {data['name']}",
        f"Plugins: {data['total_plugins']}  |  Skills: {data['total_skills']}  |  Agents: {data['total_agents']}\n",
        f"{'ID':<32}{'Name':<38}{'Skills':>6}  {'Agents':>6}",
        "─" * 82,
    ]
    for p in data["plugins"]:
        lines.append(
            f"{p['id']:<32}{p['name']:<38}{len(p['skills']):>6}  {len(p['agents']):>6}"
        )
    lines.append("\nTo install: say \"install plugin <plugin-id>\"")
    return "\n".join(lines)


@mcp.tool()
def search_plugins(query: str) -> str:
    """
    Search plugins by keyword across plugin ID, name, description, tags, and skill IDs.

    Args:
        query: Search keyword (e.g. "aws", "spring", "testing", "migration")
    """
    q = query.lower()
    results = [
        p for p in _load_marketplace()["plugins"]
        if q in p["id"].lower()
        or q in p["name"].lower()
        or q in p["description"].lower()
        or any(q in t for t in p["tags"])
        or any(q in s["id"].lower() for s in p["skills"])
    ]
    if not results:
        return f"No plugins found for '{query}'. Try list_plugins to see all."
    lines = [f"Search results for '{query}' ({len(results)} plugin(s)):\n"]
    for p in results:
        lines.append(f"  {p['id']}  —  {p['name']}  ({len(p['skills'])} skills)")
        lines.append(f"  {p['description']}\n")
    return "\n".join(lines)


@mcp.tool()
def list_plugin_skills(plugin_id: str) -> str:
    """
    List all skills in a specific plugin.

    Args:
        plugin_id: Plugin ID (e.g. "pl-sdlc", "pl-cloud-aws")
    """
    plugin = _get_plugin(plugin_id)
    if not plugin:
        ids = ", ".join(p["id"] for p in _load_marketplace()["plugins"])
        return f"Plugin '{plugin_id}' not found.\nAvailable: {ids}"
    lines = [f"# {plugin['name']}  ({plugin_id})", f"\n## Skills ({len(plugin['skills'])})\n"]
    for s in plugin["skills"]:
        lines.append(f"- {s['id']}")
    if plugin["agents"]:
        lines.append(f"\n## Agents ({len(plugin['agents'])})\n")
        for a in plugin["agents"]:
            lines.append(f"- @{a['id']}")
    return "\n".join(lines)


@mcp.tool()
def install_plugin(plugin_id: str) -> str:
    """
    Install a plugin — copies skill files to ~/.aws/amazonq/rules/ and
    writes the plugin prompt to ~/.aws/amazonq/prompts/ so it appears
    in the Amazon Q @ dropdown.

    Args:
        plugin_id: Plugin ID to install (e.g. "pl-sdlc", "pl-cloud-aws", "--all")
    """
    # Handle --all
    if plugin_id == "--all":
        data = _load_marketplace()
        results = []
        for p in data["plugins"]:
            results.append(install_plugin(p["id"]))
        return "\n".join(results)

    plugin = _get_plugin(plugin_id)
    if not plugin:
        return f"Plugin '{plugin_id}' not found. Use list_plugins to browse."

    if not SKILLS_BASE.exists():
        return (
            f"Skills are not bundled in this installation.\n"
            f"Run this command in your terminal instead:\n"
            f"  aq-marketplace install {plugin_id}"
        )

    AQ_RULES_DIR.mkdir(parents=True, exist_ok=True)
    AQ_PROMPTS_DIR.mkdir(parents=True, exist_ok=True)

    installed, missing = 0, 0

    # Copy skills → ~/.aws/amazonq/rules/<skill-id>/SKILL.md
    for skill in plugin["skills"]:
        src = SKILLS_BASE / skill["id"] / "SKILL.md"
        if src.exists():
            dest = AQ_RULES_DIR / skill["id"]
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest / "SKILL.md")
            installed += 1
        else:
            missing += 1

    # Copy agents → ~/.aws/amazonq/prompts/<agent-id>.agent.md
    for agent in plugin["agents"]:
        src = AGENTS_BASE / f"{agent['id']}.agent.md"
        if src.exists():
            shutil.copy2(src, AQ_PROMPTS_DIR / f"{agent['id']}.agent.md")

    # Write plugin wrapper → ~/.aws/amazonq/prompts/<plugin-id>.agent.md
    (AQ_PROMPTS_DIR / f"{plugin_id}.agent.md").write_text(
        _generate_wrapper(plugin), encoding="utf-8"
    )

    lines = [
        f"✅ Installed: {plugin['name']}",
        f"   Skills  → ~/.aws/amazonq/rules/  ({installed} files)",
        f"   Agents  → ~/.aws/amazonq/prompts/",
    ]
    if missing:
        lines.append(f"   Skipped : {missing} skill files not found in package")
    lines.append(f"\nRestart Amazon Q then type @ to use @{plugin_id}")
    return "\n".join(lines)


@mcp.tool()
def uninstall_plugin(plugin_id: str) -> str:
    """
    Remove an installed plugin from ~/.aws/amazonq/.

    Args:
        plugin_id: Plugin ID to remove (e.g. "pl-sdlc")
    """
    plugin = _get_plugin(plugin_id)
    if not plugin:
        return f"Plugin '{plugin_id}' not found."

    removed = 0
    for skill in plugin["skills"]:
        d = AQ_RULES_DIR / skill["id"]
        if d.exists():
            shutil.rmtree(d)
            removed += 1
    for agent in plugin["agents"]:
        f = AQ_PROMPTS_DIR / f"{agent['id']}.agent.md"
        if f.exists():
            f.unlink()
            removed += 1
    wrapper = AQ_PROMPTS_DIR / f"{plugin_id}.agent.md"
    if wrapper.exists():
        wrapper.unlink()
        removed += 1

    return f"✅ Uninstalled: {plugin['name']}  ({removed} files removed)"


@mcp.tool()
def marketplace_summary() -> str:
    """High-level overview of the entire marketplace."""
    data = _load_marketplace()
    lines = [
        f"# {data['name']}",
        f"{data['description']}\n",
        f"**{data['total_plugins']} plugins  |  {data['total_skills']} skills  |  {data['total_agents']} agents**\n",
    ]
    for p in data["plugins"]:
        lines.append(f"- **{p['id']}**  —  {p['name']}  ({len(p['skills'])} skills)")
    return "\n".join(lines)


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    mcp.run()
