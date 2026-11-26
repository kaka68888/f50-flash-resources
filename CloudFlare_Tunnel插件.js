//<script>
/**
 * UFI-TOOLS 插件：CloudFlare Tunnel 内网穿透（cloudflared）
 * 适用：ZTE F50 / U30 Air（Android 高级后台，需开启“高级功能”）
 *
 * 相比旧版 CloudFlare_Tunnel内网穿透插件优化版：
 *   1. 直接粘贴 `cloudflared.exe service install <token>` 整条命令即可，自动提取 token；
 *   2. 安装最新版 cloudflared-linux-arm64，多镜像自动回退，也支持本地文件上传安装；
 *   3. 自动把 Android 系统证书拼成 CA 包并设置 SSL_CERT_FILE，解决 x509 证书错误；
 *   4. 检测到 DNS 解析失败（Android 上常见）时，自动切换 chroot 兼容模式重试；
 *   5. 启动脚本独立成 start.sh，开机自启不再把 token 写进 /sdcard 脚本；
 *   6. 新增真实连接状态（日志出现 Registered tunnel connection）、协议切换、网络自检。
 *
 * 隧道对外的域名/端口（Public Hostname）在 Cloudflare Zero Trust 控制台配置，
 * 本插件只负责把设备连上 Cloudflare 边缘。
 */
(async () => {
    // ====== 可配置区域 ======
    // 默认 token（首次打开时预填，可在界面里改）
    const DEFAULT_TOKEN = '' // 出于安全考虑已移除，请在插件界面粘贴自己的 tunnel token
    const pluginPath = '/data/cloudflared'
    const binaryPath = `${pluginPath}/cloudflared`
    const tokenFile = `${pluginPath}/token.txt`
    const protocolFile = `${pluginPath}/protocol.txt`
    const modeFile = `${pluginPath}/mode.txt`
    const caFile = `${pluginPath}/cacert.pem`
    const rootfs = `${pluginPath}/rootfs`
    const startScript = `${pluginPath}/start.sh`
    const logFile = `${pluginPath}/cloudflared.log`
    const pidFile = `${pluginPath}/cloudflared.pid`
    const bootSH = '/sdcard/ufi_tools_boot.sh'
    const curlPath = '/data/data/com.minikano.f50_sms/files/curl'
    const downloadTmp = '/data/cloudflared_download'
    // 下载源：前一个失败自动换下一个
    const DOWNLOAD_URLS = [
        'https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
        'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
        'https://gh.llkk.cc/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
        'https://github.moeyy.xyz/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
        'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
    ]
    // Android 系统证书目录两个位置都要看（Android 14+ 系统证书在 APEX 里）
    const SYSTEM_CA_DIRS = ['/apex/com.android.conscrypt/cacerts', '/system/etc/security/cacerts']
    // 系统证书拼不出来时兜底下载
    const CA_URLS = [
        'https://curl.se/ca/cacert.pem',
        'https://ghfast.top/https://raw.githubusercontent.com/bagder/ca-bundle/master/ca-bundle.crt',
    ]
    // ====== 可配置区域结束 ======

    const run = (cmd, timeout) => runShellWithRoot(cmd, timeout)
    const wait = (ms = 1000) => new Promise((resolve) => setTimeout(resolve, ms))
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const readFile = async (path) => ((await run(`cat ${path} 2>/dev/null`)).content || '').trim()
    const hasFile = async (path) => ((await run(`[ -s ${path} ] && echo yes || echo no`)).content || '').includes('yes')

    const checkAdvanceFunc = async () => {
        const res = await run('whoami')
        return !!(res.content && res.content.includes('root'))
    }

    const checkIsInstalled = async () => {
        const res = await run(`[ -x ${binaryPath} ] && echo yes || echo no`)
        return (res.content || '').includes('yes')
    }

    const getVersion = async () => {
        const res = await run(`${binaryPath} --version 2>&1 | head -n 1`)
        const m = (res.content || '').match(/version\s+(\S+)/i)
        return m ? m[1] : ''
    }

    // 从“整条安装命令”或纯 token 中提取 token，并解出隧道 ID
    const parseToken = (input) => {
        let token = (input || '').trim()
        const m = token.match(/(?:--token\s+|install\s+)([A-Za-z0-9+/=_-]{30,})/)
        if (m) token = m[1]
        if (!/^[A-Za-z0-9+/=_-]{30,}$/.test(token)) return null
        try {
            const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
            const json = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)))
            return { token, tunnelId: json.t || '', account: json.a || '' }
        } catch (e) {
            return { token, tunnelId: '', account: '' }
        }
    }

    const saveToken = async (token) => {
        const res = await run(`printf '%s' '${token}' > ${tokenFile} && chmod 600 ${tokenFile}`)
        return res.success
    }

    // 用 ps 找 cloudflared 进程（[c] 写法避免匹配到本条 grep 自身）
    const listPids = async () => {
        const res = await run(`ps -ef | grep '[c]loudflared tunnel' | awk '{print $2}'`)
        return (res.content || '').split(/\s+/).filter((x) => /^\d+$/.test(x))
    }

    const isRunning = async () => (await listPids()).length > 0

    const killTunnel = async () => {
        const pids = await listPids()
        for (const pid of pids) await run(`kill ${pid}`)
        if (pids.length) {
            await wait(1500)
            for (const pid of await listPids()) await run(`kill -9 ${pid} 2>/dev/null`)
        }
        await run(`rm -f ${pidFile}`)
        return pids.length
    }

    const getMode = async () => (await readFile(modeFile)) || 'normal'
    const getProtocol = async () => (await readFile(protocolFile)) || 'http2'

    const checkIsBootUp = async () => {
        const res = await run(`grep -q 'cloudflared/start.sh' ${bootSH} 2>/dev/null; echo $?`)
        return (res.content || '').trim() === '0'
    }

    const setAutoStart = async (enable) => {
        if (enable) {
            await run(`
            touch ${bootSH}
            sed -i '/cloudflared\\/start.sh/d' ${bootSH} 2>/dev/null
            grep -q 'cloudflared/start.sh' ${bootSH} 2>/dev/null || echo 'sh ${startScript} >/dev/null 2>&1 &' >> ${bootSH}
            `)
        } else {
            await run(`sed -i '/cloudflared\\/start.sh/d' ${bootSH} 2>/dev/null`)
        }
    }

    // 独立启动脚本：正常模式 / chroot 兼容模式都在这里决定，开机自启只调用它
    const writeStartScript = async () => {
        const body = `#!/system/bin/sh
# 由 UFI-TOOLS 插件生成，请勿手动修改
DIR=${pluginPath}
TOKEN=$(cat $DIR/token.txt 2>/dev/null)
[ -n "$TOKEN" ] || exit 1
PROTO=$(cat $DIR/protocol.txt 2>/dev/null)
[ -n "$PROTO" ] || PROTO=http2
MODE=$(cat $DIR/mode.txt 2>/dev/null)
[ -n "$MODE" ] || MODE=normal
cd $DIR || exit 1
if [ "$MODE" = "chroot" ]; then
  nohup chroot $DIR/rootfs /cloudflared tunnel run --protocol $PROTO --token "$TOKEN" >> $DIR/cloudflared.log 2>&1 &
else
  SSL_CERT_FILE=$DIR/cacert.pem nohup $DIR/cloudflared tunnel run --protocol $PROTO --token "$TOKEN" >> $DIR/cloudflared.log 2>&1 &
fi
echo $! > $DIR/cloudflared.pid
`
        const res = await run(`cat > ${startScript} <<'EOF'
${body}EOF
chmod 755 ${startScript}`)
        return res.success
    }

    // 把 Android 系统 CA 证书拼成一个 PEM 包，供 cloudflared（Go 程序）校验 TLS
    const buildCaBundle = async () => {
        const dirs = SYSTEM_CA_DIRS.map((d) => `[ -d "${d}" ] && cat "${d}"/* >> ${caFile} 2>/dev/null`).join('\n')
        const res = await run(`
        mkdir -p ${pluginPath}
        rm -f ${caFile}
        ${dirs}
        wc -c < ${caFile} 2>/dev/null
        `)
        let size = parseInt(((res.content || '').trim() || '0'))
        if (size > 100000) return size
        for (const url of CA_URLS) {
            await run(`rm -f ${caFile}`)
            await run(`${curlPath} -fsSL --connect-timeout 15 --max-time 90 -o ${caFile} '${url}'`)
            size = parseInt(((await run(`wc -c < ${caFile} 2>/dev/null`)).content || '').trim() || '0')
            if (size > 100000) return size
        }
        return 0
    }

    // 多镜像下载 cloudflared-linux-arm64
    const downloadBinary = async () => {
        for (let i = 0; i < DOWNLOAD_URLS.length; i++) {
            createToast(`下载 cloudflared（源 ${i + 1}/${DOWNLOAD_URLS.length}）...`, '', 8000)
            await run(`rm -f ${downloadTmp}`)
            await run(`${curlPath} -fL --retry 2 --connect-timeout 20 --max-time 900 -o ${downloadTmp} '${DOWNLOAD_URLS[i]}'`, 960 * 1000)
            const size = parseInt(((await run(`wc -c < ${downloadTmp} 2>/dev/null`)).content || '').trim() || '0')
            if (size > 8000000) return true
        }
        return false
    }

    // chroot 兼容环境：自带 resolv.conf + CA 证书，绕开 Android 上 Go 程序解析不到 DNS 的问题
    const setupCompat = async () => {
        const res = await run(`
        mkdir -p ${rootfs}/etc/ssl/certs ${rootfs}/dev
        ln -f ${binaryPath} ${rootfs}/cloudflared 2>/dev/null || cp -f ${binaryPath} ${rootfs}/cloudflared
        [ -s ${caFile} ] && cp -f ${caFile} ${rootfs}/etc/ssl/certs/ca-certificates.crt
        printf 'nameserver 223.5.5.5\\nnameserver 119.29.29.29\\nnameserver 1.1.1.1\\n' > ${rootfs}/etc/resolv.conf
        printf '127.0.0.1 localhost\\n' > ${rootfs}/etc/hosts
        [ -e ${rootfs}/dev/null ] || mknod ${rootfs}/dev/null c 1 3 2>/dev/null
        [ -e ${rootfs}/dev/urandom ] || mknod ${rootfs}/dev/urandom c 1 9 2>/dev/null
        echo COMPAT_OK
        `)
        return (res.content || '').includes('COMPAT_OK')
    }

    const readLog = async (n = 60) => (await run(`tail -n ${n} ${logFile} 2>/dev/null`)).content || ''

    // 根据日志判断当前状态
    const classifyLog = (log) => {
        if (/Registered tunnel connection/i.test(log)) return 'connected'
        if (/(Unauthorized|Invalid tunnel secret|Provided Tunnel token is not valid|failed to authenticate)/i.test(log)) return 'auth'
        if (/(no such host|:53:|server misbehaving|SERVFAIL|i\/o timeout)/i.test(log)) return 'dns'
        if (/(certificate signed by unknown authority|x509)/i.test(log)) return 'ca'
        return ''
    }

    const waitForConnect = async (maxSec) => {
        for (let i = 0; i < maxSec; i++) {
            await wait(1000)
            if (!(await isRunning())) return { state: 'dead', log: await readLog() }
            const log = await readLog()
            const state = classifyLog(log)
            if (state) return { state, log }
        }
        return { state: 'timeout', log: await readLog() }
    }

    // 启动隧道：正常模式失败时自动切 chroot 兼容模式再试一次
    const startTunnel = async () => {
        await run(`mkdir -p ${pluginPath}`)
        if (!(await hasFile(caFile))) await buildCaBundle()
        await writeStartScript()
        if (!(await readFile(protocolFile))) await run(`echo http2 > ${protocolFile}`)
        await killTunnel()
        await run(`rm -f ${logFile}`)
        await run(`sh ${startScript}`)
        await wait(1500)
        if (!(await isRunning())) return { state: 'dead', log: await readLog() }

        let result = await waitForConnect(25)
        if (result.state === 'connected') return result

        if (['dns', 'ca', 'timeout', 'dead'].includes(result.state) && (await getMode()) !== 'chroot') {
            createToast('连接异常，正在切换兼容模式重试...', '', 6000)
            if (await setupCompat()) {
                await run(`echo chroot > ${modeFile}`)
                await killTunnel()
                await run(`rm -f ${logFile}`)
                await run(`sh ${startScript}`)
                await wait(1500)
                result = await waitForConnect(35)
            }
        }
        return result
    }

    const describeResult = (r) => {
        if (r.state === 'connected') return ''
        const tail = esc((r.log || '').trim().slice(-700))
        const wrap = (text) => `<div style="width:320px;text-align:left;pointer-events:all;">${text}
            <pre style="white-space:pre-wrap;max-height:180px;overflow:auto;font-size:11px;">${tail || '无日志'}</pre></div>`
        if (r.state === 'auth') return wrap('Token 无效或隧道已被删除，请重新复制安装命令。')
        if (r.state === 'dns') return wrap('DNS 解析失败（兼容模式也不通），请检查设备外网。')
        if (r.state === 'ca') return wrap('TLS 证书校验失败，请点“安装/更新”重新生成 CA 包。')
        if (r.state === 'dead') return wrap('cloudflared 启动后立即退出。')
        return wrap('启动后 30 秒内未连上 CloudFlare 边缘，请查看日志。')
    }

    const reportStart = async (r, info) => {
        if (r.state === 'connected') {
            createToast(`<div style="width:320px;text-align:center;pointer-events:all;">
                CloudFlare Tunnel 已连接<br/>
                ${info && info.tunnelId ? `隧道 ID: ${esc(info.tunnelId)}<br/>` : ''}
                运行模式: ${await getMode()} / 协议: ${await getProtocol()}<br/>
                请到 Cloudflare Zero Trust 控制台确认域名映射
            </div>`, 'green', 15000)
        } else {
            createToast(describeResult(r), 'red', 20000)
        }
        await updateLabel()
    }

    const doInstall = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        const info = parseToken(document.getElementById('cf_token').value)
        if (!info) return createToast('Token 格式不正确，请粘贴完整安装命令或 token', 'red', 10000)

        const wasRunning = await isRunning()
        createToast('下载 cloudflared，可能有点慢...', '', 8000)
        if (!(await downloadBinary())) {
            return createToast('下载失败：可换网络重试，或用“本地安装”上传 cloudflared-linux-arm64', 'red', 15000)
        }
        // 覆盖正在运行的二进制会报 Text file busy，下载成功后再停旧进程
        if (wasRunning) await killTunnel()
        const mv = await run(`
        mkdir -p ${pluginPath}
        mv -f ${downloadTmp} ${binaryPath}
        chmod 755 ${binaryPath}
        `)
        if (!mv.success) return createToast('写入 cloudflared 失败', 'red')
        const ver = await getVersion()
        if (!ver) {
            await run(`rm -f ${binaryPath}`)
            return createToast(`二进制无法运行：${esc((await run(`${binaryPath} --version 2>&1 | head -n 3`)).content)}`, 'red', 15000)
        }

        // chroot 兼容模式里是硬链接，升级后必须重新链接新二进制
        if ((await getMode()) === 'chroot') await setupCompat()

        createToast('生成 CA 证书包...')
        const caSize = await buildCaBundle()
        await writeStartScript()
        await saveToken(info.token)
        if (!(await readFile(modeFile))) await run(`echo normal > ${modeFile}`)
        if (!(await readFile(protocolFile))) await run(`echo http2 > ${protocolFile}`)
        await setAutoStart(true)
        createToast(`cloudflared ${ver} 安装完成（CA 包 ${Math.round(caSize / 1024)} KB），正在启动...`, 'green', 10000)
        await reportStart(await startTunnel(), info)
    }

    const doStart = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        if (!(await checkIsInstalled())) return createToast('请先安装 cloudflared！')
        const info = parseToken(document.getElementById('cf_token').value)
        if (!info) return createToast('Token 格式不正确，请粘贴完整安装命令或 token', 'red', 10000)
        await saveToken(info.token)
        createToast('正在启动 CloudFlare Tunnel...', '', 6000)
        await reportStart(await startTunnel(), info)
    }

    const doStop = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        if (!(await isRunning())) return createToast('隧道当前没有运行')
        const n = await killTunnel()
        createToast(n ? '已停止 CloudFlare Tunnel' : '未找到运行中的进程', 'green')
        updateLabel()
    }

    const doRestart = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        if (!(await checkIsInstalled())) return createToast('请先安装 cloudflared！')
        let token = await readFile(tokenFile)
        if (!token) {
            const info = parseToken(document.getElementById('cf_token').value)
            if (!info) return createToast('没有已保存的 Token，请先填写', 'red')
            token = info.token
            await saveToken(token)
        }
        createToast('正在重启 CloudFlare Tunnel...', '', 6000)
        await reportStart(await startTunnel(), parseToken(token))
    }

    const showStatus = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        const installed = await checkIsInstalled()
        const pids = await listPids()
        const ver = installed ? await getVersion() : ''
        const info = parseToken(await readFile(tokenFile))
        const log = await readLog(40)
        const connected = /Registered tunnel connection/i.test(log)
        const lines = [
            `安装状态: ${installed ? `已安装 ${ver}` : '未安装'}`,
            `运行状态: ${pids.length ? `运行中 (PID ${pids.join(',')})` : '已停止'}`,
            `隧道连接: ${connected ? '已连接' : (pids.length ? '尚未确认' : '-')}`,
            `隧道 ID: ${info && info.tunnelId ? info.tunnelId : '未知'}`,
            `运行模式: ${await getMode()}`,
            `协议: ${await getProtocol()}`,
            `开机自启: ${(await checkIsBootUp()) ? '已开启' : '未开启'}`,
            `安装目录: ${pluginPath}`,
            `日志文件: ${logFile}`,
        ]
        createFixedToast(`cf_status_${Date.now()}`, `<pre style="white-space:pre-wrap;text-align:left;min-width:300px;max-height:320px;overflow:auto;">${esc(lines.join('\n'))}</pre>`)
    }

    const viewLogs = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        const log = await readLog(120)
        const patterns = [
            { re: /(Unauthorized|Invalid tunnel secret|Provided Tunnel token is not valid)/i, tip: 'Token 无效或隧道已删除' },
            { re: /(no such host|:53:|server misbehaving)/i, tip: 'DNS 解析失败，可尝试重启或切兼容模式' },
            { re: /(certificate signed by unknown authority|x509)/i, tip: '证书校验失败，请重新生成 CA 包' },
            { re: /(connection refused|failed to dial|i\/o timeout)/i, tip: '网络连接失败，检查外网/防火墙' },
        ]
        const tip = (patterns.find((p) => p.re.test(log)) || {}).tip || ''
        createFixedToast(`cf_log_${Date.now()}`, `<pre style="white-space:pre-wrap;text-align:left;min-width:320px;max-height:360px;overflow:auto;font-size:11px;">${esc(log || '暂无日志')}</pre>${tip ? `<div style="color:#f59e0b;margin-top:6px;">${esc(tip)}</div>` : ''}`)
    }

    const exportLog = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        const t = Math.floor(Date.now() + Math.random())
        const dest = `/data/data/com.minikano.f50_sms/files/uploads/cloudflared_log_${t}.log`
        createToast('导出日志中...')
        const res = await run(`
        rm -f /data/data/com.minikano.f50_sms/files/uploads/cloudflared_log_*
        sleep 1
        cp ${logFile} ${dest}
        chmod 777 ${dest}
        `)
        if (!res.success) return createToast('导出失败！', 'red')
        const a = document.createElement('a')
        a.download = `cloudflared日志_${t}.log`
        a.href = `/api/uploads/cloudflared_log_${t}.log`
        a.target = '_blank'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        a.remove()
    }

    const selfCheck = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        const res = await run(`
        echo '== 版本 =='
        ${binaryPath} --version 2>&1 | head -n 1
        echo '== Token =='
        [ -s ${tokenFile} ] && echo '已保存' || echo '未保存'
        echo '== 进程 =='
        ps -ef | grep '[c]loudflared tunnel' | head -n 3
        echo '== resolv.conf =='
        cat /etc/resolv.conf 2>&1 | head -n 4
        echo '== DNS(argotunnel) =='
        ping -c 1 -W 3 region1.v2.argotunnel.com 2>&1 | head -n 2
        echo '== 外网(baidu) =='
        ${curlPath} -s -m 8 -o /dev/null -w '%{http_code}\\n' https://www.baidu.com
        echo '== CA 包 =='
        wc -c < ${caFile} 2>/dev/null
        echo '== 日志尾部 =='
        tail -n 8 ${logFile} 2>/dev/null | cut -c1-200
        `, 120 * 1000)
        createFixedToast(`cf_diag_${Date.now()}`, `<pre style="white-space:pre-wrap;text-align:left;min-width:320px;max-height:380px;overflow:auto;font-size:11px;">${esc(res.content || '无输出')}</pre>`)
    }

    const uninstall = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        createToast('卸载中...', 'red')
        await killTunnel()
        await setAutoStart(false)
        const res = await run(`rm -rf ${pluginPath}`)
        if (!res.success) return createToast('卸载失败！', 'red')
        createToast('卸载成功，token 与日志已删除', 'green')
        updateLabel()
    }

    // 离线兜底：上传 cloudflared-linux-arm64
    const installLocalFile = async (file) => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        if (!file) return
        if (file.size > 96 * 1024 * 1024) return createToast('文件不能超过 96MB！', 'red')
        createToast('上传 cloudflared 中，请稍等...', '', 20000)
        try {
            const formData = new FormData()
            formData.append('file', file)
            const res = await (await fetch(`${KANO_baseURL}/upload_img`, {
                method: 'POST',
                headers: common_headers,
                body: formData,
            })).json()
            if (!res.url) throw res.error || '上传失败'
            if (await isRunning()) await killTunnel()
            const r = await run(`
            SRC=/data/data/com.minikano.f50_sms/files/${res.url}
            mkdir -p ${pluginPath}
            cp -f "$SRC" ${binaryPath}
            chmod 755 ${binaryPath}
            `)
            if (!r.success) throw '写入失败'
            const ver = await getVersion()
            if (!ver) {
                await run(`rm -f ${binaryPath}`)
                throw '这不是可运行的 arm64 cloudflared'
            }
            await buildCaBundle()
            await writeStartScript()
            if ((await getMode()) === 'chroot') await setupCompat()
            const info = parseToken(document.getElementById('cf_token').value)
            if (info) await saveToken(info.token)
            await setAutoStart(true)
            createToast(`本地安装成功：${ver}`, 'green')
            updateLabel()
        } catch (err) {
            console.error(err)
            createToast(`本地安装失败: ${esc(err)}`, 'red', 12000)
        }
    }

    // ====== 面板 ======
    const container = document.querySelector('.functions-container')
    if (!container) return
    container.insertAdjacentHTML('afterend', `
<div id="CLOUDFLARE_TUNNEL" style="width: 100%; margin-top: 10px;">
    <div class="title" style="margin: 6px 0;">
        <strong>CloudFlare Tunnel</strong>
        <span id="cf_label" style="opacity:.7;font-size:12px;margin-left:6px;"></span>
        <div style="display: inline-block;" id="collapse_cf_btn"></div>
    </div>
    <div class="collapse" id="collapse_cf" data-name="close" style="height: 0px; overflow: hidden;">
        <div class="collapse_box">
            <div style="font-size:12px;opacity:.8;margin-bottom:6px;">粘贴 cloudflared 安装命令或 token（已预填）</div>
            <textarea id="cf_token" rows="3" placeholder="cloudflared.exe service install eyJ..."
                style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid var(--border-color,#444);background:transparent;color:inherit;font-size:12px;resize:vertical;">${DEFAULT_TOKEN}</textarea>
            <div style="font-size:11px;opacity:.6;margin:4px 0 10px;">
                隧道入口（域名 → 本地端口）在 Cloudflare Zero Trust 控制台配置，本插件只负责连上边缘节点。
            </div>
            <div id="cf_action_box" style="margin-bottom:8px;display:flex;gap:10px;flex-wrap:wrap"></div>
            <ul class="deviceList">
                <li style="padding:10px;font-size:12px;line-height:1.8;">
                    安装目录：${pluginPath}<br/>
                    日志文件：${logFile}<br/>
                    开机自启：/sdcard/ufi_tools_boot.sh
                </li>
            </ul>
        </div>
    </div>
</div>
`)

    const tokenEl = document.getElementById('cf_token')
    const savedToken = await readFile(tokenFile)
    if (savedToken) tokenEl.value = savedToken

    const makeBtn = (text, handler) => {
        const btn = document.createElement('button')
        btn.classList.add('btn')
        btn.textContent = text
        btn.onclick = async () => {
            if (btn.disabled) return
            btn.disabled = true
            try {
                await handler()
            } catch (e) {
                console.error(e)
                createToast(`操作失败: ${esc(e)}`, 'red')
            } finally {
                btn.disabled = false
            }
        }
        return btn
    }

    const btn_install = makeBtn('安装/更新', doInstall)
    const btn_start = makeBtn('启动隧道', doStart)
    const btn_stop = makeBtn('停止隧道', doStop)
    const btn_restart = makeBtn('重启隧道', doRestart)
    const btn_status = makeBtn('运行状态', showStatus)
    const btn_log = makeBtn('查看日志', viewLogs)
    const btn_export = makeBtn('导出日志', exportLog)
    const btn_check = makeBtn('网络自检', selfCheck)

    const protocolBtn = document.createElement('button')
    protocolBtn.classList.add('btn')
    protocolBtn.textContent = '协议: http2'
    protocolBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        const cur = await getProtocol()
        const next = cur === 'http2' ? 'auto' : (cur === 'auto' ? 'quic' : 'http2')
        await run(`mkdir -p ${pluginPath} && echo ${next} > ${protocolFile}`)
        protocolBtn.textContent = `协议: ${next}`
        createToast(`协议已切换为 ${next}，重启隧道后生效`, 'green')
    }

    const bootBtn = document.createElement('button')
    bootBtn.classList.add('btn')
    bootBtn.textContent = '开机自启'
    bootBtn.style.background = ''
    bootBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast('没有开启高级功能，无法使用！', 'red')
        if (!(await checkIsInstalled())) return createToast('请先安装 cloudflared！')
        if (await checkIsBootUp()) {
            await setAutoStart(false)
            bootBtn.style.background = ''
            createToast('已取消开机自启', 'green')
        } else {
            await writeStartScript()
            await setAutoStart(true)
            bootBtn.style.background = 'var(--dark-btn-color-active)'
            createToast('已设置开机自启', 'green')
        }
    }

    const btn_uninstall = document.createElement('button')
    btn_uninstall.classList.add('btn')
    btn_uninstall.textContent = '卸载隧道'
    let uninstallClick = 0
    btn_uninstall.onclick = async () => {
        uninstallClick++
        setTimeout(() => { uninstallClick = 0 }, 3000)
        if (uninstallClick < 2) return createToast('再点一次卸载 CloudFlare Tunnel')
        uninstallClick = 0
        await uninstall()
    }

    const fileEl = document.createElement('input')
    fileEl.type = 'file'
    fileEl.style.display = 'none'
    fileEl.onchange = async (e) => {
        const file = e.target.files && e.target.files[0]
        fileEl.value = ''
        await installLocalFile(file)
    }
    const btn_local = makeBtn('本地安装', async () => fileEl.click())

    const updateLabel = async () => {
        const el = document.getElementById('cf_label')
        if (!el) return
        if (!(await checkIsInstalled())) {
            el.textContent = '未安装'
        } else {
            const ver = await getVersion()
            const running = await isRunning()
            let state = running ? '运行中' : '已停止'
            if (running && /Registered tunnel connection/i.test(await readLog(40))) state = '运行中 · 已连接'
            el.textContent = `${ver || '?'} · ${state}`
        }
        const p = await getProtocol()
        protocolBtn.textContent = `协议: ${p}`
        bootBtn.style.background = (await checkIsBootUp()) ? 'var(--dark-btn-color-active)' : ''
    }

    const box = document.getElementById('cf_action_box')
    ;[btn_install, btn_start, btn_stop, btn_restart, btn_status, btn_log, btn_export, btn_check, btn_local, protocolBtn, bootBtn, btn_uninstall]
        .forEach((btn) => box.appendChild(btn))
    box.appendChild(fileEl)

    collapseGen('#collapse_cf_btn', '#collapse_cf', '#collapse_cf', () => {
        updateLabel()
    })
    updateLabel()
})()
//</script >
