"""An MCP client on the official Python SDK, driven by JSON lines on stdin, one call at a time or many.

Each request is {"id", "tool", "args"}, or {"id", "list": true}. Each answer is {"id", "text",
"isError"}, with "images" where it has pictures, or {"id", "tools"}.
"""
import asyncio
import json
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def answer(session, request):
    if request.get("list"):
        listed = await session.list_tools()
        return {"id": request["id"], "tools": [tool.name for tool in listed.tools]}
    result = await session.call_tool(request["tool"], request["args"])
    text = "".join(block.text for block in result.content if block.type == "text")
    reply = {"id": request["id"], "text": text, "isError": bool(result.is_error)}
    images = [
        {"mimeType": block.mime_type, "data": block.data}
        for block in result.content
        if block.type == "image"
    ]
    if images:
        reply["images"] = images
    return reply


async def main():
    params = StdioServerParameters(
        command=sys.argv[1], args=sys.argv[2:], env=dict(os.environ)
    )
    loop = asyncio.get_running_loop()
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print(json.dumps({"ready": True}), flush=True)
            running = set()

            async def serve(request):
                try:
                    reply = await answer(session, request)
                except Exception as error:
                    # A call the protocol itself refuses, such as a tool this server doesn't offer.
                    reply = {"id": request["id"], "text": str(error), "isError": True}
                print(json.dumps(reply), flush=True)

            while True:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    break
                task = asyncio.create_task(serve(json.loads(line)))
                running.add(task)
                task.add_done_callback(running.discard)
            await asyncio.gather(*running)


asyncio.run(main())
