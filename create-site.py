#!/usr/bin/env python3
# 调用宝塔面板自身的建站逻辑创建站点（需用面板自带 pyenv 运行，且以 root 执行）：
#   /www/server/panel/pyenv/bin/python3 create-site.py <domain> <site_path> [port]
import sys

sys.path.insert(0, "/www/server/panel")
sys.path.insert(0, "/www/server/panel/class")

import json  # noqa: E402

import public  # noqa: E402
import panelSite  # noqa: E402


def main():
    domain = sys.argv[1] if len(sys.argv) > 1 else "codex.example.com"
    site_path = sys.argv[2] if len(sys.argv) > 2 else f"/www/wwwroot/{domain}"
    port = sys.argv[3] if len(sys.argv) > 3 else "80"

    get = public.dict_obj()
    get.webname = json.dumps(
        {
            "domain": domain,
            "domainlist": [],
            "count": 0,
            "type": "static",
        }
    )
    get.port = port
    get.ps = domain
    get.path = site_path
    get.type_id = "0"
    get.type = "PHP"
    get.version = "00"  # 纯静态站点，实际请求由 nginx 反代到 Node 服务
    get.ftp = "false"
    get.sql = "false"
    get.codeing = "utf8"
    get.set_ssl = "false"
    get.force_ssl = "false"

    site = panelSite.panelSite()
    result = site.AddSite(get)
    print(result)


if __name__ == "__main__":
    main()
