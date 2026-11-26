//<script>
/**
 * UFI-TOOLS 插件：OpenList
 * 适用：ZTE F50 / U30 Air（Android 高级后台，需开启“高级功能”）
 *
 * 与插件商店里 minikano 原版的区别：
 *   1. 安装/升级使用 OpenList 官方最新 arm64 包（v4.2.7），不再依赖固定的旧镜像；
 *   2. 下载支持多个镜像自动回退（GitHub 官方 + 国内加速镜像）；
 *   3. 提供“启动OpenList”按钮，未运行时可直接启动；
 *   4. 支持“本地安装”：从手机存储选 tar.gz/二进制离线安装，设备无外网也能装；
 *   5. 启动时不再删除 data/config.json，重启/开机后配置和密码不会丢失；
 *   6. 界面显示当前已安装的 OpenList 版本。
 *
 * 修改版本号只需改下面的 OPENLIST_VERSION 和 DOWNLOAD_URLS 两组常量。
 */
(async () => {
    // ====== 可配置区域 ======
    // 当前插件打包的 OpenList 版本
    const OPENLIST_VERSION = '4.2.7'
    // openlist 安装目录（数据在 ${pluginPath}/data）
    const pluginPath = '/data/openlist'
    // 开机自启脚本
    const bootSH = '/sdcard/ufi_tools_boot.sh'
    // 运行日志（stdout/stderr）
    const logFile = '/sdcard/openlist_log.log'
    // OpenList 自身日志
    const runtimeLogFile = `${pluginPath}/data/log/log.log`
    // 启动命令（去掉了原版每次启动都删除 config.json 的行为）
    const startCommand = `cd ${pluginPath} && nohup ${pluginPath}/openlist server > ${logFile} 2>&1 &`
    // 下载源：按顺序尝试，前一个失败自动换下一个
    const DOWNLOAD_URLS = [
        `https://ghfast.top/https://github.com/OpenListTeam/OpenList/releases/download/v${OPENLIST_VERSION}/openlist-android-arm64.tar.gz`,
        `https://gh-proxy.com/https://github.com/OpenListTeam/OpenList/releases/download/v${OPENLIST_VERSION}/openlist-android-arm64.tar.gz`,
        `https://github.com/OpenListTeam/OpenList/releases/download/v${OPENLIST_VERSION}/openlist-android-arm64.tar.gz`,
    ]
    const downloadTmp = '/data/kano_openlist.tar.gz'
    const extractTmp = '/data/kano_openlist_extract'
    // UFI-TOOLS 自带的静态 curl
    const curlPath = '/data/data/com.minikano.f50_sms/files/curl'
    // ====== 可配置区域结束 ======

    const run = (cmd, timeout) => runShellWithRoot(cmd, timeout)

    const killProcessByName = async (processName) => {
        const collectPids = async () => {
            const psResult = await run(`ps -ef | grep "${processName}" | grep -v grep`)
            return (psResult.content || '').trim().split('\n')
                .map((line) => line.trim().split(/\s+/)[1])
                .filter((pid) => pid && /^\d+$/.test(pid))
        }

        let pids = await collectPids()
        if (pids.length === 0) {
            return {
                success: false,
                content: "未找到相关进程"
            }
        }

        const total = pids.length
        for (const pid of pids) {
            await run(`kill ${pid}`)
        }
        // 给进程一点退出时间，仍在的补 SIGKILL，确保端口 5244 被释放
        await run('sleep 1')
        pids = await collectPids()
        for (const pid of pids) {
            await run(`kill -9 ${pid} 2>/dev/null`)
        }

        return {
            success: true,
            content: `已停止 ${total} 个进程`
        }
    }

    const checkAdvanceFunc = async () => {
        const res = await run('whoami')
        return !!(res.content && res.content.includes('root'))
    }

    // 检测是否设置了开机自启
    const checkIsBootUp = async () => {
        const res = await run(`
        grep -q 'openlist server' ${bootSH}
        echo $?
        `)
        return res.content.trim() == '0'
    }

    const checkIsInstalled = async () => {
        const res = await run(`
        [ -x ${pluginPath}/openlist ] && echo yes || echo no
        `)
        return res.content.includes('yes')
    }

    // 是否已有 openlist server 在运行
    const isOpenListRunning = async () => {
        const res = await run(`ps -ef | grep "openlist server" | grep -v grep`)
        return !!(res.content && res.content.trim())
    }

    // 读取已安装版本
    const getInstalledVersion = async () => {
        const res = await run(`${pluginPath}/openlist version 2>&1 | head -n 1`)
        const m = res.content.match(/v?\d+\.\d+\.\d+/)
        return m ? m[0] : ''
    }

    // 依次尝试多个下载源
    const downloadPackage = async () => {
        for (let i = 0; i < DOWNLOAD_URLS.length; i++) {
            const url = DOWNLOAD_URLS[i]
            createToast(`下载 OpenList ${OPENLIST_VERSION}（源 ${i + 1}/${DOWNLOAD_URLS.length}）...`, '', 8000)
            await run(`rm -f ${downloadTmp}`)
            await run(`${curlPath} -fL --retry 2 --connect-timeout 20 --max-time 600 -o ${downloadTmp} '${url}'`, 660 * 1000)
            const check = await run(`[ -s ${downloadTmp} ] && echo OK || echo EMPTY`)
            if (check.content.includes('OK')) return true
        }
        return false
    }

    // 解包并把 openlist 二进制放到安装目录（不碰 data 目录）
    const extractBinary = async () => {
        const res = await run(`
        rm -rf ${extractTmp}
        mkdir -p ${extractTmp} ${pluginPath}
        tar -zxf ${downloadTmp} -C ${extractTmp}
        BIN=$(find ${extractTmp} -type f -name openlist | head -n 1)
        [ -n "$BIN" ] || exit 1
        cp -f "$BIN" ${pluginPath}/openlist
        chmod 755 ${pluginPath}/openlist
        rm -rf ${extractTmp}
        rm -f ${downloadTmp}
        `)
        return res.success
    }

    // 启动 openlist 并实时输出日志
    const startOpenList = async (cb = () => { }) => {
        createToast("启动 OpenList 中...")
        const res = await run(`${startCommand}`)
        if (!res.success) return createToast("启动 OpenList 失败!", 'red')

        const { el, close } = createFixedToast('openlist_toast', `<pre style="white-space: pre-wrap;min-width:300px;text-align: center;">等待日志中...</pre>`)

        let timer = null
        const timeout = 100 * 1000
        const t_now = performance.now()
        timer && clearTimeout(timer)
        timer = setInterval(async () => {
            const r = await run(`timeout 2s awk '{print}' ${logFile}`)
            el.style.maxHeight = '400px'
            el.style.overflow = 'auto'
            el.innerHTML = `<pre style="pointer-events: all;white-space: pre-wrap;min-width:300px;text-align: center;">${r.content}<br>等待启动完成...</pre>`
            el.scrollTo({ top: 99999 })
            if (r.content.includes('start HTTP server') && r.content.includes('0.0.0.0:5244')) {
                cb && cb()
                setTimeout(() => {
                    close()
                    refresh && refresh.click()
                }, 2000)
                clearTimeout(timer)
            }
            if ((performance.now() - t_now) >= timeout) {
                clearTimeout(timer)
                close()
                if (await isOpenListRunning()) {
                    refresh && refresh.click()
                } else {
                    const tail = ((await run(`tail -n 20 ${logFile} 2>/dev/null`)).content || '').trim()
                    createToast(`OpenList 启动失败${tail ? '：' + tail.slice(-300) : ''}`, 'red', 20000)
                }
            }
        }, 1000)
    }

    const setAutoStart = async (enable) => {
        if (enable) {
            await run(`
            sed -i '/openlist server/d' ${bootSH} 2>/dev/null
            echo '${startCommand}' >> ${bootSH}
            `)
        } else {
            await run(`sed -i '/openlist server/d' ${bootSH} 2>/dev/null`)
        }
    }

    // 安装/升级共用流程
    const installOrUpgrade = async (isUpgrade) => {
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        createToast("下载所需组件，可能有点慢...", '', 8000)
        if (!(await downloadPackage())) {
            return createToast("下载 OpenList 失败，请检查网络后重试", 'red')
        }
        if (isUpgrade) {
            // 必须先停进程，否则 Linux 会因 "Text file busy" 拒绝覆盖正在运行的二进制
            const killResult = await killProcessByName('openlist')
            createToast(killResult.content)
            await run('sleep 1')
        }

        createToast("解压 OpenList 文件...")
        if (!(await extractBinary())) {
            if (isUpgrade) await run(`${startCommand}`)
            return createToast("解压 OpenList 文件出错!", 'red')
        }

        if (!isUpgrade) {
            createToast("设置默认密码中...")
            await run(`
            cd ${pluginPath}
            ${pluginPath}/openlist admin set admin
            `)
            await setAutoStart(true)
        } else {
            // 升级：清掉旧日志目录（data 下其它内容全部保留）
            await run(`rm -rf ${pluginPath}/data/log`)
        }

        startOpenList(() => {
            createToast(`<div style="width:300px;text-align:center;pointer-events: all;">
            OpenList ${OPENLIST_VERSION} 启动成功！<br />
            web 地址（端口 5244）<br />
            <a href="http://${UFI_DATA.lan_ipaddr}:5244" target="_blank">http://${UFI_DATA.lan_ipaddr}:5244</a><br />
            用户名密码均为 admin<br />
            安装目录: ${pluginPath}<br/>
            运行日志: ${logFile}<br/>
            </div>
            `, '', 20000)
            setTimeout(() => {
                refresh && refresh.click()
            }, 2000)
        })
    }

    // 离线安装：从手机存储选 tar.gz（或已解压的 openlist），走局域网传到 App 再安装，设备无需外网
    let localInstalling = false
    const installLocalFile = async (file) => {
        if (!file) return
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (file.size > 96 * 1024 * 1024) return createToast("文件不能超过 96MB！", 'red')
        localInstalling = true
        let src = ''
        try {
            const hadData = (await run(`[ -d ${pluginPath}/data ] && echo yes || echo no`)).content.includes('yes')
            createToast("上传安装包中，请稍等...", '', 20000)
            const formData = new FormData()
            formData.append('file', file)
            const resp = await fetch(`${KANO_baseURL}/upload_img`, {
                method: 'POST',
                headers: common_headers,
                body: formData,
            })
            const res = await resp.json()
            if (!res.url) throw (res.error || '上传失败')
            src = `/data/data/com.minikano.f50_sms/files/${res.url}`

            // 已有进程先停掉，避免覆盖二进制时报 "Text file busy"
            await killProcessByName('openlist')
            await run('sleep 1')
            createToast("安装 OpenList 中...")

            const isTar = /\.(tar\.gz|tgz|gz)$/i.test(file.name)
            const cmd = isTar ? `
                rm -rf ${extractTmp}
                mkdir -p ${extractTmp} ${pluginPath}
                tar -zxf '${src}' -C ${extractTmp}
                BIN=$(find ${extractTmp} -type f -name openlist | head -n 1)
                [ -n "$BIN" ] || exit 1
                cp -f "$BIN" ${pluginPath}/openlist
                chmod 755 ${pluginPath}/openlist
                rm -rf ${extractTmp}
            ` : `
                mkdir -p ${pluginPath}
                cp -f '${src}' ${pluginPath}/openlist
                chmod 755 ${pluginPath}/openlist
            `
            const r = await run(cmd)
            if (!r.success) throw '解压/写入失败'

            const ver = await getInstalledVersion()
            if (!ver) {
                await run(`rm -f ${pluginPath}/openlist`)
                throw '这不是可运行的 arm64 openlist'
            }
            // 仅全新安装时设置默认密码，已有数据不重置
            if (!hadData) {
                await run(`cd ${pluginPath} && ${pluginPath}/openlist admin set admin`)
            }
            await setAutoStart(true)
            updateVersionLabel()
            createToast(`本地安装成功：${ver}`, 'green')
            startOpenList(() => {
                createToast('启动成功', 'green')
            })
        } catch (err) {
            console.error(err)
            createToast(`本地安装失败: ${err}`, 'red', 12000)
        } finally {
            if (src) await run(`rm -f '${src}'`)
            localInstalling = false
        }
    }

    // ====== 按钮 ======
    const btn_install = document.createElement('button')
    btn_install.textContent = "安装OpenList"
    let disabled_btn_enabled = false
    btn_install.onclick = async () => {
        if (disabled_btn_enabled) return
        disabled_btn_enabled = true
        try {
            if (await checkIsInstalled()) {
                return createToast("你已经安装过了！")
            }
            await installOrUpgrade(false)
        } finally {
            disabled_btn_enabled = false
            updateVersionLabel()
        }
    }

    const btn_start = document.createElement('button')
    btn_start.textContent = "启动OpenList"
    btn_start.onclick = async () => {
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        if (!(await checkIsInstalled())) {
            return createToast("你还没有安装 OpenList！")
        }
        if (await isOpenListRunning()) {
            refresh && refresh.click()
            return createToast("OpenList 已在运行中", 'green')
        }
        // 先清理可能残留的进程并等待端口释放，避免新实例因 5244 被占用立即退出
        await killProcessByName('openlist')
        await run('sleep 1')
        startOpenList(() => {
            createToast(`启动成功`, 'green')
        })
    }

    const fileEl = document.createElement('input')
    fileEl.type = 'file'
    fileEl.style.display = 'none'
    fileEl.onchange = async (e) => {
        const file = e.target.files && e.target.files[0]
        fileEl.value = ''
        if (file) await installLocalFile(file)
    }

    const btn_local = document.createElement('button')
    btn_local.textContent = "本地安装"
    btn_local.onclick = async () => {
        if (localInstalling) return
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        fileEl.click()
    }

    const btn_uninstall = document.createElement('button')
    btn_uninstall.textContent = "卸载OpenList"
    let ct = 0
    btn_uninstall.onclick = async () => {
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        ct++
        setTimeout(() => { ct = 0 }, 3000)
        if (ct < 2) { return createToast("再点一次卸载OpenList") }
        createToast("卸载中...", 'red')
        const killResult = await killProcessByName('openlist')
        createToast(killResult.content)
        await setAutoStart(false)
        const res = await run(`rm -rf ${pluginPath}`)
        if (!res.success) return createToast("卸载失败！", 'red')
        createToast(`卸载成功!`, 'green')
        updateVersionLabel()
    }

    const btn_restart = document.createElement('button')
    btn_restart.textContent = "重启OpenList"
    btn_restart.onclick = async () => {
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        if (!(await checkIsInstalled())) {
            return createToast("你还没有安装 OpenList！")
        }
        createToast("重启 OpenList 中...", 'green')
        const killResult = await killProcessByName('openlist')
        createToast(killResult.content)
        startOpenList(() => {
            createToast(`重启成功`, 'green')
        })
    }

    const btn_stop = document.createElement('button')
    btn_stop.textContent = "停止OpenList"
    btn_stop.onclick = async () => {
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        if (!(await checkIsInstalled())) {
            return createToast("你还没有安装 OpenList！")
        }
        createToast("停止 OpenList 中...", 'green')
        const killResult = await killProcessByName('openlist')
        if (!killResult.success) return createToast(killResult.content, 'red')
        createToast(killResult.content, 'green')
    }

    const boot_on = document.createElement('button')
    boot_on.id = "openlist_boot_on"
    boot_on.classList.add('btn')
    boot_on.textContent = "开机自启"
    boot_on.style.background = ""
    boot_on.addEventListener('click', async () => {
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        if (!(await checkIsInstalled())) {
            return createToast("你还没有安装 OpenList！")
        }
        if (await checkIsBootUp()) {
            await setAutoStart(false)
            boot_on.style.background = ""
            createToast("已取消开机自启", 'green')
        } else {
            await setAutoStart(true)
            boot_on.style.background = "var(--dark-btn-color-active)"
            createToast("已设置开机自启", 'green')
        }
    })

    const refresh = document.createElement('button')
    refresh.classList.add('btn')
    refresh.textContent = "刷新网页"
    refresh.onclick = () => {
        document.getElementById('mm_iframe').src = `http://${UFI_DATA.lan_ipaddr}:5244/?t=` + Date.now()
    }

    const exportBtn = document.createElement('button')
    exportBtn.classList.add('btn')
    exportBtn.textContent = "导出运行日志"
    exportBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) {
            return createToast("没有开启高级功能，无法使用！", 'red')
        }
        if (!(await checkIsInstalled())) {
            return createToast("你还没有安装 OpenList！")
        }
        createToast("导出运行日志中...", '')
        const t = Math.floor(Date.now() + Math.random())
        const res = await run(`
        rm -f /data/data/com.minikano.f50_sms/files/uploads/openlist_log_*
        sleep 1
        cp ${runtimeLogFile} /data/data/com.minikano.f50_sms/files/uploads/openlist_log_${t}.log
        chmod 777 /data/data/com.minikano.f50_sms/files/uploads/openlist_log_${t}.log
        `)
        if (!res.success) return createToast("导出失败！", 'red')
        const a = document.createElement('a')
        a.download = `openlist日志_${t}.log`
        a.href = `/api/uploads/openlist_log_${t}.log`
        a.target = "_blank"
        a.style.display = "none"
        document.body.appendChild(a)
        a.click()
        a.remove()
    }

    const wait = (sec = 100) => new Promise((resolve) => {
        setTimeout(resolve, sec)
    })
    const container = document.querySelector('.functions-container')
    while (!UFI_DATA.lan_ipaddr) {
        await wait()
    }
    container.insertAdjacentHTML("afterend", `
<div id="IFRAME_KANO" style="width: 100%; margin-top: 10px;">
    <div class="title" style="margin: 6px 0 ;">
        <strong>OpenList</strong>
        <span id="openlist_version_label" style="opacity:.7;font-size:12px;margin-left:6px;"></span>
        <div style="display: inline-block;" id="collapse_openlist_btn"></div>
    </div>
    <div class="collapse" id="collapse_openlist" data-name="close" style="height: 0px; overflow: hidden;">
        <div class="collapse_box">
        <div id="olist_action_box" style="margin-bottom:8px;display:flex;gap:10px;flex-wrap:wrap"></div>
            <ul class="deviceList">
<li style="padding:10px">
        <iframe id="mm_iframe" src="http://${UFI_DATA.lan_ipaddr}:5244/?t=${Date.now()}" style="border:none;padding:0;margin:0;width:100%;height:500px;border-radius: 10px;overflow: hidden;opacity: .6;"></iframe>
</li> </ul>
        </div>
    </div>
</div>
`)

    const updateVersionLabel = async () => {
        const el = document.getElementById('openlist_version_label')
        if (!el) return
        if (!(await checkIsInstalled())) {
            el.textContent = `未安装（最新 ${OPENLIST_VERSION}）`
            return
        }
        const v = await getInstalledVersion()
        el.textContent = v ? `已安装 ${v} / 最新 ${OPENLIST_VERSION}` : `已安装 / 最新 ${OPENLIST_VERSION}`
    }

    const mmBox = document.querySelector('#olist_action_box')
    mmBox.appendChild(btn_install)
    mmBox.appendChild(btn_local)
    mmBox.appendChild(btn_start)
    mmBox.appendChild(btn_stop)
    mmBox.appendChild(btn_restart)
    mmBox.appendChild(btn_uninstall)
    mmBox.appendChild(exportBtn)
    mmBox.appendChild(boot_on)
    mmBox.appendChild(refresh)
    mmBox.appendChild(fileEl)
    collapseGen("#collapse_openlist_btn", "#collapse_openlist", "#collapse_openlist", (e) => { })

    checkIsBootUp().then(isBootUp => {
        if (isBootUp) boot_on.style.background = "var(--dark-btn-color-active)"
    })
    updateVersionLabel()
})()
//</script >
