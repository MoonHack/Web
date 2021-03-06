'use strict';

function initialize() {
	const sCanvas = document.getElementById('shellCanvas');
	const gl2 = sCanvas.getContext('webgl2');
	const gl = gl2 || sCanvas.getContext('webgl');
	const sStatus = document.getElementById('statusContainer');

	const sTmpCanvas = document.getElementById('textTempCanvas');
	const sTmpCanvasCtx = sTmpCanvas.getContext('2d');

	const worker = new Worker('static/worker.js');

	let user = '', canInput = false;

	const dpiScalingFactor = 1;

	const charFont = `${16 * dpiScalingFactor}px white_rabbitregular`;
	const cursorHeight = 4 * dpiScalingFactor;
	const lineHeight = 16 * dpiScalingFactor;
	const lineSpacing = 0 * dpiScalingFactor;
	const charWidth = 9 * dpiScalingFactor;
	const totalLineHeight = lineHeight + lineSpacing;

	let lineCount;
	let charsPerLine;

	let commandHistoryPos = 0;
	let commandHistory = [];

	let cursorBlinkOn = true;
	let cursorPos = 0;
	let typedText = '';
	let cliText = [];
	let cliTextSplit = [];
	let lineBuffer = [];
	let lineArrayBuffers = [];
	let renderQueued = false;
	let cliTextSplitDirty = true;
	let needsResize = false;
	let cliScrollOffset = 0;

	let texturesToPurge = [];

	// Attach pre-existing shaders
	function createShader(program, type, sourceCode) {
		if (gl2) {
			if (type === gl.FRAGMENT_SHADER) {
				sourceCode = 'out lowp vec4 my_fragColor;\n' + sourceCode.replace(/texture2D\(/g, 'texture(');
			}
			sourceCode = '#version 300 es\n' + sourceCode;
		} else {
			switch(type) {
				case gl.FRAGMENT_SHADER:
					sourceCode = sourceCode.replace(/^[\t ]*in /gm, 'varying ')
											.replace(/my_fragColor/g, 'gl_FragColor');
					break;
				case gl.VERTEX_SHADER:
					sourceCode = sourceCode.replace(/^[\t ]*in /gm, 'attribute ')
											.replace(/^[\t ]*out /gm, 'varying ');
					break;
			}
		}
		// Compiles either a shader of type gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
		var shader = gl.createShader(type);
		gl.shaderSource(shader, sourceCode);
		gl.compileShader(shader);

		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const info = gl.getShaderInfoLog(shader);
			throw 'Could not compile WebGL program. \n\n' + info;
		}
		
		gl.attachShader(program, shader);
	}
	function createProgram(vertex, fragment) {
		const program = gl.createProgram();
		createShader(program, gl.VERTEX_SHADER, vertex);
		createShader(program, gl.FRAGMENT_SHADER, fragment);

		gl.linkProgram(program);

		if (!gl.getProgramParameter( program, gl.LINK_STATUS)) {
			const info = gl.getProgramInfoLog(program);
			throw 'Could not compile WebGL program. \n\n' + info;
		}

		return program;
	}

	const program = createProgram(`
	in mediump vec2 a_position;
	in mediump vec2 a_tex_position;
	uniform mediump vec2 u_resolution;
	out mediump vec2 v_tex_position;
	
	void main() {
		// convert the rectangle from pixels to 0.0 to 1.0
		vec2 zeroToOne = a_position / u_resolution;
	
		// convert from 0->1 to 0->2
		vec2 zeroToTwo = zeroToOne * 2.0;
	
		// convert from 0->2 to -1->+1 (clipspace)
		vec2 clipSpace = zeroToTwo - 1.0;
	
		gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
		v_tex_position = a_tex_position;
	}
	`, `
	in mediump vec2 v_tex_position;
	uniform sampler2D u_texture;
	uniform lowp vec4 u_fixedcolor;

	void main() {
		if (u_fixedcolor.w > 0.0) {
			my_fragColor = u_fixedcolor;
		} else {
			my_fragColor = texture2D(u_texture, v_tex_position);
		}
	}
	`);

	gl.useProgram(program);
	const aPosition = gl.getAttribLocation(program, 'a_position');
	const aTexPosition = gl.getAttribLocation(program, 'a_tex_position');
	const uResolution = gl.getUniformLocation(program, 'u_resolution');
	const uTexture = gl.getUniformLocation(program, 'u_texture');
	const uFixedColor = gl.getUniformLocation(program, 'u_fixedcolor');

	// 101215 rgb(16, 18, 21)
	gl.clearColor(16.0/255.0, 18.0/255.0, 21.0/255.0, 1.0);

	const posBuffer = gl.createBuffer();
	gl.enableVertexAttribArray(aPosition);
	gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
	gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

	function cursorBlink() {
		cursorBlinkOn = !cursorBlinkOn;
		queueRender();
	}
	let cursorBlinkInterval = setInterval(cursorBlink, 1000);
	function cursorForceOn() {
		clearInterval(cursorBlinkInterval);
		cursorBlinkInterval = setInterval(cursorBlink, 1000);
		if (!cursorBlinkOn) {
			cursorBlinkOn = true;
			queueRender();
		}
	}

	function purgeTextures(arr) {
		for(let i = 0; i < arr.length; i++) {
			const o = arr[i];
			if (o[1]) {
				texturesToPurge.push(o[1]);
			}
		}
	}

	const formatShortMap = {
		color: 'c',
		colour: 'c',
	};

	function parseText(str) {
		let formatting = [];
		let inCC = false;
		let _cc = '';
		let _str = '';
		let _parts = [];
		let _partsLen = 0;
		const _lines = [];
		for (let i = 0; i < str.length; i++) {
			const c = str[i];
			if (inCC) {
				if (c === '>') {
					inCC = false;
					if (_cc == '/') {
						formatting.shift();	
					} else {
						const _format = {};
						_cc.split(',').forEach(attr => {
							const [k,v] = attr.split('=', 2);
							if (!v) {
								_format.c = k;
								return;
							}
							const ks = formatShortMap[k];
							if (ks) {
								_format[ks] = v;
								return;
							}
							_format[k] = v;
						});
						formatting.unshift(_format);
					}
				}
				_cc += c;
			} else if (c === '<') {
				inCC = true;
				_cc = '';
				_parts.push([_str,formatting[0]]);
				_partsLen += _str.length;
				_str = '';
			} else {
				_str += c;
			}
		}
		
		if (_str.length > 0) {
			_parts.push([_str, formatting[0]]);
			_partsLen += _str.length;
		}

		return [_parts, _partsLen];
	}

	function wrapText([parts,partsLen]) {
		const _lines = [];
		let idx = 0;
		let offset = 0;
		for (let i = 0; i < partsLen; i += charsPerLine) {
			let _str = [];
			let _left = charsPerLine;
			while (_left > 0) {
				const p = parts[idx];
				if (!p) {
					break;
				}
				const len = p[0].length - offset;
				if (len > _left) {
					_str.push([p[0].substr(offset, _left), p[1]]);
					offset += _left;
					break;
				}

				if (offset) {
					_str.push([p[0].substr(offset), p[1]]);
				} else {
					_str.push(p);
				}
				offset = 0;
				idx++;
				_left -= len;
			}
			_lines.push([_str, null]);
		}
		return _lines;
	}

	function recomputeView() {
		cliTextSplitDirty = true;
		cursorForceOn();
	}

	function recomputeLines() {
		let newCliScreenView = [];
		for (let i = 0; i < cliText.length; i++) {
			const data = wrapText(cliText[i]);
			newCliScreenView = newCliScreenView.concat(data);
		}
		purgeTextures(cliTextSplit);
		cliTextSplit = newCliScreenView;
		recomputeView();
	}

	function resize() {
		const width = document.body.clientWidth - 9*2;
		const height = document.body.clientHeight - (9 + 36);

		if (width === sCanvas.width && height === sCanvas.height) {
			return;
		}

		sCanvas.width = width;
		sCanvas.height = height;
		sTmpCanvas.width = width;
		sTmpCanvas.height = lineHeight;
		gl.uniform2f(uResolution, sCanvas.width, sCanvas.height);
		gl.viewport(0, 0, sCanvas.width, sCanvas.height);

		const _lineCount = Math.floor((height / totalLineHeight) - 1);
		const _charsPerLine = Math.floor(width / charWidth);

		if (_lineCount !== lineCount || _charsPerLine !== charsPerLine) {
			const _relativeWidth = _charsPerLine * charWidth;
			lineCount = _lineCount;

			const lc22 = (lineCount + 2) * 2;
			const bData = new Float32Array(4 * lc22);
			const btData = new Float32Array(4 * lc22);
			let y = 0;
			let o = 0;
			for(let i = 0; i < lc22; i++) {
				const i2 = i % 2;

				btData[o] = 0;
				bData[o++] = 0;

				btData[o] = i2;
				bData[o++] = y;

				btData[o] = 1;
				bData[o++] = _relativeWidth;

				btData[o] = i2;
				bData[o++] = y;

				if (i2 === 0) {
					y += totalLineHeight;
				}
			}
			gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, bData, gl.STATIC_DRAW);
			gl.bindBuffer(gl.ARRAY_BUFFER, texPosBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, btData, gl.STATIC_DRAW);
			gl.bindBuffer(gl.ARRAY_BUFFER, null);
		}

		if (_charsPerLine !== charsPerLine) {
			charsPerLine = _charsPerLine;
			recomputeLines();
		}
		worker.postMessage(['resize', charsPerLine, lineCount]);
	}

	const texPosBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, texPosBuffer);
	gl.vertexAttribPointer(aTexPosition, 2, gl.FLOAT, false, 0, 0);
	gl.enableVertexAttribArray(aTexPosition);

	function renderTextToTexture(text, cb) {
		sTmpCanvasCtx.fillStyle = '#101215';
		sTmpCanvasCtx.fillRect(0, 0, sTmpCanvas.width, sTmpCanvas.height);
		sTmpCanvasCtx.font = charFont;
		sTmpCanvasCtx.textBaseline = 'top';
		let x = 0;
		for (let i = 0; i < text.length; i++) {
			const t = text[i];
			if (!t || !t[0]) {
				continue;
			}
			const f = t[1] || {};
			sTmpCanvasCtx.fillStyle = f.c || '#77AEEE';
			const tx = t[0];
			for (let j = 0; j < tx.length; j++) {
				sTmpCanvasCtx.fillText(tx[j], x, 0);
				x += charWidth;
			}
		}
		if (cb) {
			cb(sTmpCanvasCtx);
		}
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sTmpCanvas);
	}

	const promptTexture = gl.createTexture();
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, promptTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

	let r_lastTypedText, r_lastUser, r_lastCursorBlinkOn, r_lastCanInput;

	function mkPromptLine(user, sgn, typedText, preformat) {
		if (preformat) {
			return [[user,{c:'#AAAAAA'}], [sgn,{c:'#FFFFFF'}], [typedText,{c:'#888888'}]];	
		}
		return `<c=#AAAAAA>${user}</><c=#FFFFFF>${sgn}</><c=#888888>${typedText}</>`;
	}

	function render() {
		renderQueued = false;
		if (needsResize) {
			resize();
			needsResize = false;
		}

		for (let i = 0; i < texturesToPurge.length; i++) {
			gl.deleteTexture(texturesToPurge[i]);
		}
		texturesToPurge = [];

		const width = gl.canvas.width;

		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(uTexture, 0);

		const renderLineStart = Math.max(0, cliTextSplit.length - (cliScrollOffset + lineCount));
		const renderLineEnd = Math.min(renderLineStart + lineCount, cliTextSplit.length);

		if (cliTextSplitDirty) {
			for (let i = 0; i < renderLineStart; i++) {
				const t = cliTextSplit[i][1];
				if (t) {
					cliTextSplit[i][1] = null;
					gl.deleteTexture(t);
				}
			}

			for (let i = renderLineEnd; i < cliTextSplit.length; i++) {
				const t = cliTextSplit[i][1];
				if (t) {
					cliTextSplit[i][1] = null;
					gl.deleteTexture(t);
				}
			}
			cliTextSplitDirty = false;
		}

		let y = 0;
		for (let i = renderLineStart; i < renderLineEnd; i++) {
			const currentView = cliTextSplit[i];
			if (!currentView[1]) {
				currentView[1] = gl.createTexture();
				gl.bindTexture(gl.TEXTURE_2D, currentView[1]);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);	
				renderTextToTexture(currentView[0]);
			} else {
				gl.bindTexture(gl.TEXTURE_2D, currentView[1]);
			}

			gl.drawArrays(gl.TRIANGLE_STRIP, y << 2, 4);
			y++;
		}
		
		gl.activeTexture(gl.TEXTURE1);
		gl.uniform1i(uTexture, 1);
		if (r_lastTypedText !== typedText || r_lastUser !== user || r_lastCursorBlinkOn !== cursorBlinkOn || r_lastCanInput != canInput) {
			let _r_txt = '$ ';
			let _r_typeText = typedText;
			const fixedPromptLen = 2 + user.length;
			let _r_cursorPos = cursorPos + fixedPromptLen;
			if (_r_cursorPos >= charsPerLine) {
				_r_cursorPos = charsPerLine - 1;
			}

			const charsAllowed = charsPerLine - (fixedPromptLen + 1);
			if (_r_typeText.length >= charsAllowed) {
				if (cursorPos < typedText.length) {
					const cursorOffset = typedText.length - cursorPos;
					const start = (_r_typeText.length - (charsAllowed + cursorOffset));
					_r_typeText = _r_typeText.substr(start >= 0 ? start : 0, charsAllowed + 1);
				} else if (_r_typeText.length > charsAllowed) {
					_r_typeText = _r_typeText.substr(_r_typeText.length - charsAllowed);
				}
				_r_txt = '< ';
			}

			let _r_activeLine = null;
			if (!canInput && _r_typeText === '') {
				_r_activeLine = [];
				_r_cursorPos = 0;
			}
			if (!_r_activeLine) {
				_r_activeLine = mkPromptLine(user, _r_txt, _r_typeText, true);
			}

			renderTextToTexture(_r_activeLine, (ctx) => {
				if (cursorBlinkOn) {
					ctx.fillRect(charWidth * _r_cursorPos, totalLineHeight - cursorHeight, charWidth, cursorHeight);
				}
			});
			r_lastTypedText = typedText;
			r_lastUser = user;
			r_lastCursorBlinkOn = cursorBlinkOn;
		}
		gl.drawArrays(gl.TRIANGLE_STRIP, y << 2, 4);
	}

	function queueRender() {
		if (renderQueued) {
			return;
		}
		renderQueued = true;
		requestAnimationFrame(render);
	}

	function addContent(content) {
		if (typeof content === 'string') {
			content = [content];
		}
		content = content.map(parseText);

		cliText = cliText.concat(content);
		for (let i = 0; i < content.length; i++) {
			const data = wrapText(content[i]);
			cliTextSplit = cliTextSplit.concat(data);
		}
		if (cliTextSplit.length > 2000) {
			cliTextSplit.splice(0, cliTextSplit.length - 2000);
		}
		recomputeView();
		queueRender();
	}

	function clearContent() {
		cliText = [];
		purgeTextures(cliTextSplit);
		cliTextSplit = [];
		cliTextSplitDirty = true;
		cliScrollOffset = 0;
		queueRender();
	}

	worker.onmessage = msg => {
		msg = msg.data;
		switch(msg[0]) {
			case 'status':
				sStatus.innerHTML = msg[1];
				document.title = msg[2];
				break;
			case 'user':
				user = msg[1];
				break;
			case 'shell':
				msg.shift();
				addContent(msg);
				break;
			case 'canInput':
				if (canInput !== msg[1]) {
					canInput = msg[1];
					queueRender();
				}
				break;
			case 'init':
				worker.postMessage(['init', document.location.host, document.location.protocol]);
				break;
			case 'reload':
				document.location.reload();
				break;
		}
	};

	function onmousewheel(e) {
		if (e.deltaY < 0) {
			if (cliScrollOffset < cliTextSplit.length - lineCount) {
				cliScrollOffset++;
			} else {
				return;
			}
		} else if (e.deltaY > 0) {
			if (cliScrollOffset > 0) {
				cliScrollOffset--;
			} else {
				return;
			}
		} else {
			return;
		}
		e.preventDefault();
		queueRender();
	}

	document.addEventListener('DOMMouseScroll',onmousewheel);
	document.addEventListener('mousewheel', onmousewheel);
	document.addEventListener('wheel', onmousewheel);

	document.addEventListener('paste', e => {
		e.preventDefault();
		const text = e.clipboardData.getData('text/plain');
		if (!text) {
			return;
		}
		typedText = typedText.substr(0, cursorPos) + text + typedText.substr(cursorPos);
		cursorPos += text.length;
		queueRender();
	});

	document.addEventListener('keydown', e => {
		cursorForceOn();
		let needRender = true;
		switch (e.key) {
			case 'Backspace':
				if (cursorPos > 0) {
					typedText = typedText.substr(0, cursorPos - 1) + typedText.substr(cursorPos);
					cursorPos--;
				} else {
					needRender = false;
				}
				break;
			case 'ArrowLeft':
				if (cursorPos > 0) {
					cursorPos--;
				} else {
					needRender = false;
				}
				break;
			case 'ArrowRight':
				if (cursorPos < typedText.length) {
					cursorPos++;
				} else {
					needRender = false;
				}
				break;
			case 'ArrowUp':
				if (commandHistory.length === 0) {
					needRender = false;
					break;
				}
				if (commandHistoryPos > 0) {
					--commandHistoryPos;
				}
				typedText = commandHistory[commandHistoryPos];
				cursorPos = typedText.length;
				break;
			case 'ArrowDown':
				if (commandHistory.length === 0) {
					needRender = false;
					break;
				}
				if (commandHistoryPos < commandHistory.length - 1) {
					++commandHistoryPos;
				} else if (commandHistoryPos >= commandHistory.length) {
					commandHistoryPos = commandHistory.length - 1;
				}
				typedText = commandHistory[commandHistoryPos];
				cursorPos = typedText.length;
				break;
			case 'PageUp':
				if (cliScrollOffset < cliTextSplit.length - lineCount) {
					cliScrollOffset++;
				} else {
					needRender = false;
				}
				break;
			case 'PageDown':
				if (cliScrollOffset > 0) {
					cliScrollOffset--;
				} else {
					needRender = false;
				}
				break;
			case 'Delete':
				typedText = typedText.substr(0, cursorPos) + typedText.substr(cursorPos + 1);
				break;
			case 'Escape':
				typedText = '';
				cursorPos = 0;
				commandHistoryPos = commandHistory.length;
				break;
			case 'Home':
				cursorPos = 0;
				break;
			case 'End':
				cursorPos = typedText.length;
				break;
			default:
				return;
		}
		e.preventDefault();
		if (needRender) {
			queueRender();
		}
	});

	document.addEventListener('keypress', e => {
		cursorForceOn();
		let needRender = true;
		switch (e.key) {
			case 'Enter':
				if (!canInput) {
					needRender = false;
					break;
				}
				const t = typedText.trim();
				if (t === '') {
					addContent(mkPromptLine(user, '$', ''));
					needRender = false;
					break;
				}
				commandHistory.push(t);
				while (commandHistory.length > 100) {
					commandHistory.shift();	
				}
				commandHistoryPos = commandHistory.length;
				canInput = false;
				typedText = '';
				cursorPos = 0;
				const i = t.indexOf(' ');
				let cmd, args;
				if (i >= 0) {
					cmd = t.substr(0, i);
					args = t.substr(i + 1);
				} else {
					cmd = t;
					args = '';
				}
				addContent(mkPromptLine(user, '$ ', t));
				switch (cmd) {
					case 'user':
						if (args !== '') {
							worker.postMessage(['user',args]);
							break;
						}
						worker.postMessage(['lsuser']);
						break;
					case 'create_user':
						worker.postMessage(['mkuser', args]);
						break;
					case 'retire_user':
						worker.postMessage(['rmuser', args]);
						break;
					case 'clear':
						clearContent();
						canInput = true;
						break;
					case '$test':
						for (let i = 0; i < 100; i++) {
							addContent(`<#FF0000>TESTLINE</> ${i}`.repeat(20));
						}
						canInput = true;
						break;
					default:
						worker.postMessage(['command',cmd,args]);
						break;
				}
				needRender = false;
				break;
			default:
				if (e.ctrlKey || e.altKey) {
					return;
				}
				if (e.charCode) {
					typedText = typedText.substr(0, cursorPos) + String.fromCharCode(e.charCode) + typedText.substr(cursorPos);
					cursorPos++;
				} else {
					return;
				}
				break;
		}
		e.preventDefault();
		if (needRender) {
			queueRender();
		}
	});

	needsResize = true;
	window.onresize = () => {
		needsResize = true;
		queueRender();
	};
}