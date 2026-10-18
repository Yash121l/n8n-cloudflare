var cn = Object.create;
var vt = Object.defineProperty;
var dn = Object.getOwnPropertyDescriptor;
var fn = Object.getOwnPropertyNames;
var mn = Object.getPrototypeOf,
	pn = Object.prototype.hasOwnProperty;
var h = (n, t) => () => {
	try {
		return t || n((t = { exports: {} }).exports, t), t.exports;
	} catch (o) {
		throw ((t = 0), o);
	}
};
var hn = (n, t, o, d) => {
	if ((t && typeof t == 'object') || typeof t == 'function')
		for (let a of fn(t))
			!pn.call(n, a) &&
				a !== o &&
				vt(n, a, { get: () => t[a], enumerable: !(d = dn(t, a)) || d.enumerable });
	return n;
};
var gn = (n, t, o) => (
	(o = n != null ? cn(mn(n)) : {}),
	hn(t || !n || !n.__esModule ? vt(o, 'default', { value: n, enumerable: !0 }) : o, n)
);
var y = h((v) => {
	'use strict';
	v.__esModule = !0;
	v.extend = bt;
	v.indexOf = wn;
	v.escapeExpression = Cn;
	v.isEmpty = kn;
	v.createFrame = Pn;
	v.blockParams = En;
	v.appendContextPath = Sn;
	var vn = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#x27;',
			'`': '&#x60;',
			'=': '&#x3D;',
		},
		bn = /[&<>"'`=]/g,
		yn = /[&<>"'`=]/;
	function xn(n) {
		return vn[n];
	}
	function bt(n) {
		for (var t = 1; t < arguments.length; t++)
			for (var o in arguments[t])
				Object.prototype.hasOwnProperty.call(arguments[t], o) && (n[o] = arguments[t][o]);
		return n;
	}
	var K = Object.prototype.toString;
	v.toString = K;
	var X = function (t) {
		return typeof t == 'function';
	};
	X(/x/) &&
		(v.isFunction = X =
			function (n) {
				return typeof n == 'function' && K.call(n) === '[object Function]';
			});
	v.isFunction = X;
	var yt =
		Array.isArray ||
		function (n) {
			return n && typeof n == 'object' ? K.call(n) === '[object Array]' : !1;
		};
	v.isArray = yt;
	function wn(n, t) {
		for (var o = 0, d = n.length; o < d; o++) if (n[o] === t) return o;
		return -1;
	}
	function Cn(n) {
		if (typeof n != 'string') {
			if (n && typeof n.toHTML == 'function') return n.toHTML();
			if (n == null) return '';
			if (!n) return n + '';
			n = '' + n;
		}
		return yn.test(n) ? n.replace(bn, xn) : n;
	}
	function kn(n) {
		return !n && n !== 0 ? !0 : !!(yt(n) && n.length === 0);
	}
	function Pn(n) {
		var t = bt({}, n);
		return (t._parent = n), t;
	}
	function En(n, t) {
		return (n.path = t), n;
	}
	function Sn(n, t) {
		return (n ? n + '.' : '') + t;
	}
});
var k = h((L, xt) => {
	'use strict';
	L.__esModule = !0;
	var Q = [
		'description',
		'fileName',
		'lineNumber',
		'endLineNumber',
		'message',
		'name',
		'number',
		'stack',
	];
	function tt(n, t) {
		var o = t && t.loc,
			d = void 0,
			a = void 0,
			e = void 0,
			l = void 0;
		o &&
			o.start &&
			((d = o.start.line),
			(e = o.start.column),
			o.end && ((a = o.end.line), (l = o.end.column)),
			(n += ' - ' + d + ':' + e));
		for (var i = Error.prototype.constructor.call(this, n), r = 0; r < Q.length; r++)
			this[Q[r]] = i[Q[r]];
		Error.captureStackTrace && Error.captureStackTrace(this, tt);
		try {
			o &&
				((this.lineNumber = d),
				(this.endLineNumber = a),
				Object.defineProperty
					? (Object.defineProperty(this, 'column', { value: e, enumerable: !0 }),
						Object.defineProperty(this, 'endColumn', { value: l, enumerable: !0 }))
					: ((this.column = e), (this.endColumn = l)));
		} catch {}
	}
	tt.prototype = new Error();
	L.default = tt;
	xt.exports = L.default;
});
var Ct = h((I, wt) => {
	'use strict';
	I.__esModule = !0;
	var nt = y();
	I.default = function (n) {
		n.registerHelper('blockHelperMissing', function (t, o) {
			var d = o.inverse,
				a = o.fn;
			if (t === !0) return a(this);
			if (t === !1 || t == null) return d(this);
			if (nt.isArray(t))
				return t.length > 0 ? (o.ids && (o.ids = [o.name]), n.helpers.each(t, o)) : d(this);
			if (o.data && o.ids) {
				var e = nt.createFrame(o.data);
				(e.contextPath = nt.appendContextPath(o.data.contextPath, o.name)), (o = { data: e });
			}
			return a(t, o);
		});
	};
	wt.exports = I.default;
});
var Pt = h((z, kt) => {
	'use strict';
	z.__esModule = !0;
	function On(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var _ = y(),
		_n = k(),
		Mn = On(_n);
	function Tn(n) {
		try {
			var t = n.return;
			_.isFunction(t) && t.call(n);
		} catch {}
	}
	z.default = function (n) {
		n.registerHelper('each', function (t, o) {
			if (!o) throw new Mn.default('Must pass iterator to #each');
			var d = o.fn,
				a = o.inverse,
				e = 0,
				l = '',
				i = void 0,
				r = void 0;
			o.data && o.ids && (r = _.appendContextPath(o.data.contextPath, o.ids[0]) + '.'),
				_.isFunction(t) && (t = t.call(this)),
				o.data && (i = _.createFrame(o.data));
			function s(p, g, un, gt) {
				i &&
					((i.key = p),
					(i.index = g),
					(i.first = g === 0),
					(i.last = !!un),
					r && (i.contextPath = r + p)),
					(l = l + d(gt, { data: i, blockParams: _.blockParams([gt, p], [r + p, null]) }));
			}
			if (t && typeof t == 'object')
				if (_.isArray(t))
					for (var u = t.length; e < u; e++) e in t && s(e, e, e === t.length - 1, t[e]);
				else if (typeof Symbol == 'function' && t[Symbol.iterator])
					for (var c = t[Symbol.iterator](), m = c.next(); !m.done; ) {
						var f = c.next();
						try {
							s(e, e, f.done, m.value);
						} catch (p) {
							throw (f.done || Tn(c), p);
						}
						(m = f), e++;
					}
				else
					(function () {
						var p = void 0;
						Object.keys(t).forEach(function (g) {
							p !== void 0 && s(p, e - 1, !1, t[p]), (p = g), e++;
						}),
							p !== void 0 && s(p, e - 1, !0, t[p]);
					})();
			return e === 0 && (l = a(this)), l;
		});
	};
	kt.exports = z.default;
});
var St = h((R, Et) => {
	'use strict';
	R.__esModule = !0;
	function qn(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var Hn = k(),
		Ln = qn(Hn);
	R.default = function (n) {
		n.registerHelper('helperMissing', function () {
			if (arguments.length !== 1)
				throw new Ln.default('Missing helper: "' + arguments[arguments.length - 1].name + '"');
		});
	};
	Et.exports = R.default;
});
var Tt = h((U, Mt) => {
	'use strict';
	U.__esModule = !0;
	function In(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var Ot = y(),
		zn = k(),
		_t = In(zn);
	U.default = function (n) {
		n.registerHelper('if', function (t, o) {
			if (arguments.length != 2) throw new _t.default('#if requires exactly one argument');
			return (
				Ot.isFunction(t) && (t = t.call(this)),
				(!o.hash.includeZero && !t) || Ot.isEmpty(t) ? o.inverse(this) : o.fn(this)
			);
		}),
			n.registerHelper('unless', function (t, o) {
				if (arguments.length != 2) throw new _t.default('#unless requires exactly one argument');
				return n.helpers.if.call(this, t, { fn: o.inverse, inverse: o.fn, hash: o.hash });
			});
	};
	Mt.exports = U.default;
});
var Ht = h((A, qt) => {
	'use strict';
	A.__esModule = !0;
	A.default = function (n) {
		n.registerHelper('log', function () {
			for (
				var t = [void 0], o = arguments[arguments.length - 1], d = 0;
				d < arguments.length - 1;
				d++
			)
				t.push(arguments[d]);
			var a = 1;
			o.hash.level != null
				? (a = o.hash.level)
				: o.data && o.data.level != null && (a = o.data.level),
				(t[0] = a),
				n.log.apply(n, t);
		});
	};
	qt.exports = A.default;
});
var It = h((D, Lt) => {
	'use strict';
	D.__esModule = !0;
	D.default = function (n) {
		n.registerHelper('lookup', function (t, o, d) {
			return t && d.lookupProperty(t, o);
		});
	};
	Lt.exports = D.default;
});
var Rt = h((V, zt) => {
	'use strict';
	V.__esModule = !0;
	function Rn(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var q = y(),
		Un = k(),
		An = Rn(Un);
	V.default = function (n) {
		n.registerHelper('with', function (t, o) {
			if (arguments.length != 2) throw new An.default('#with requires exactly one argument');
			q.isFunction(t) && (t = t.call(this));
			var d = o.fn;
			if (q.isEmpty(t)) return o.inverse(this);
			var a = o.data;
			return (
				o.data &&
					o.ids &&
					((a = q.createFrame(o.data)),
					(a.contextPath = q.appendContextPath(o.data.contextPath, o.ids[0]))),
				d(t, { data: a, blockParams: q.blockParams([t], [a && a.contextPath]) })
			);
		});
	};
	zt.exports = V.default;
});
var et = h((F) => {
	'use strict';
	F.__esModule = !0;
	F.registerDefaultHelpers = Qn;
	F.moveHelperToHooks = te;
	function E(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var Dn = Ct(),
		Vn = E(Dn),
		Fn = Pt(),
		Bn = E(Fn),
		jn = St(),
		Zn = E(jn),
		Wn = Tt(),
		Gn = E(Wn),
		$n = Ht(),
		Yn = E($n),
		Nn = It(),
		Jn = E(Nn),
		Xn = Rt(),
		Kn = E(Xn);
	function Qn(n) {
		Vn.default(n),
			Bn.default(n),
			Zn.default(n),
			Gn.default(n),
			Yn.default(n),
			Jn.default(n),
			Kn.default(n);
	}
	function te(n, t, o) {
		n.helpers[t] && ((n.hooks[t] = n.helpers[t]), o || (n.helpers[t] = void 0));
	}
});
var At = h((B, Ut) => {
	'use strict';
	B.__esModule = !0;
	var ne = y();
	B.default = function (n) {
		n.registerDecorator('inline', function (t, o, d, a) {
			var e = t;
			return (
				o.partials ||
					((o.partials = {}),
					(e = function (l, i) {
						var r = d.partials;
						d.partials = ne.extend({}, r, o.partials);
						var s = t(l, i);
						return (d.partials = r), s;
					})),
				(o.partials[a.args[0]] = a.fn),
				e
			);
		});
	};
	Ut.exports = B.default;
});
var Dt = h((rt) => {
	'use strict';
	rt.__esModule = !0;
	rt.registerDefaultDecorators = le;
	function ee(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var re = At(),
		oe = ee(re);
	function le(n) {
		oe.default(n);
	}
});
var ot = h((j, Vt) => {
	'use strict';
	j.__esModule = !0;
	var ae = y(),
		M = {
			methodMap: ['debug', 'info', 'warn', 'error'],
			level: 'info',
			lookupLevel: function (t) {
				if (typeof t == 'string') {
					var o = ae.indexOf(M.methodMap, t.toLowerCase());
					o >= 0 ? (t = o) : (t = parseInt(t, 10));
				}
				return t;
			},
			log: function (t) {
				if (((t = M.lookupLevel(t)), typeof console < 'u' && M.lookupLevel(M.level) <= t)) {
					var o = M.methodMap[t];
					console[o] || (o = 'log');
					for (var d = arguments.length, a = Array(d > 1 ? d - 1 : 0), e = 1; e < d; e++)
						a[e - 1] = arguments[e];
					console[o].apply(console, a);
				}
			},
		};
	j.default = M;
	Vt.exports = j.default;
});
var lt = h((T) => {
	'use strict';
	T.__esModule = !0;
	T.createProtoAccessControl = ce;
	T.resultIsAllowed = de;
	T.isPrototypeConstructor = fe;
	T.resetLoggedProperties = pe;
	function ie(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var Ft = y(),
		se = ot(),
		ue = ie(se),
		Z = Object.create(null);
	function ce(n) {
		var t = Object.create(null);
		(t.__proto__ = !1), Ft.extend(t, n.allowedProtoProperties);
		var o = Object.create(null);
		return (
			(o.constructor = !1),
			(o.__defineGetter__ = !1),
			(o.__defineSetter__ = !1),
			(o.__lookupGetter__ = !1),
			(o.__lookupSetter__ = !1),
			Ft.extend(o, n.allowedProtoMethods),
			{
				properties: { whitelist: t, defaultValue: n.allowProtoPropertiesByDefault },
				methods: { whitelist: o, defaultValue: n.allowProtoMethodsByDefault },
			}
		);
	}
	function de(n, t, o) {
		return Bt(typeof n == 'function' ? t.methods : t.properties, o);
	}
	function fe(n, t, o) {
		return t === 'constructor' && typeof o == 'function' && n === o.prototype;
	}
	function Bt(n, t) {
		return n.whitelist[t] !== void 0
			? n.whitelist[t] === !0
			: n.defaultValue !== void 0
				? n.defaultValue
				: (me(t), !1);
	}
	function me(n) {
		Z[n] !== !0 &&
			((Z[n] = !0),
			ue.default.log(
				'error',
				'Handlebars: Access has been denied to resolve the property "' +
					n +
					`" because it is not an "own property" of its parent.
You can add a runtime option to disable the check or this warning:
See https://handlebarsjs.com/api-reference/runtime-options.html#options-to-control-prototype-access for details`,
			));
	}
	function pe() {
		Object.keys(Z).forEach(function (n) {
			delete Z[n];
		});
	}
});
var ut = h((w) => {
	'use strict';
	w.__esModule = !0;
	w.HandlebarsEnvironment = st;
	function jt(n) {
		return n && n.__esModule ? n : { default: n };
	}
	var S = y(),
		he = k(),
		at = jt(he),
		ge = et(),
		ve = Dt(),
		be = ot(),
		W = jt(be),
		ye = lt(),
		xe = '4.7.10';
	w.VERSION = xe;
	var we = 8;
	w.COMPILER_REVISION = we;
	var Ce = 7;
	w.LAST_COMPATIBLE_COMPILER_REVISION = Ce;
	var ke = {
		1: '<= 1.0.rc.2',
		2: '== 1.0.0-rc.3',
		3: '== 1.0.0-rc.4',
		4: '== 1.x.x',
		5: '== 2.0.0-alpha.x',
		6: '>= 2.0.0-beta.1',
		7: '>= 4.0.0 <4.3.0',
		8: '>= 4.3.0',
	};
	w.REVISION_CHANGES = ke;
	var it = '[object Object]';
	function st(n, t, o) {
		(this.helpers = n || {}),
			(this.partials = t || {}),
			(this.decorators = o || {}),
			ge.registerDefaultHelpers(this),
			ve.registerDefaultDecorators(this);
	}
	st.prototype = {
		constructor: st,
		logger: W.default,
		log: W.default.log,
		registerHelper: function (t, o) {
			if (S.toString.call(t) === it) {
				if (o) throw new at.default('Arg not supported with multiple helpers');
				S.extend(this.helpers, t);
			} else this.helpers[t] = o;
		},
		unregisterHelper: function (t) {
			delete this.helpers[t];
		},
		registerPartial: function (t, o) {
			if (S.toString.call(t) === it) S.extend(this.partials, t);
			else {
				if (typeof o > 'u')
					throw new at.default('Attempting to register a partial called "' + t + '" as undefined');
				this.partials[t] = o;
			}
		},
		unregisterPartial: function (t) {
			delete this.partials[t];
		},
		registerDecorator: function (t, o) {
			if (S.toString.call(t) === it) {
				if (o) throw new at.default('Arg not supported with multiple decorators');
				S.extend(this.decorators, t);
			} else this.decorators[t] = o;
		},
		unregisterDecorator: function (t) {
			delete this.decorators[t];
		},
		resetLoggedPropertyAccesses: function () {
			ye.resetLoggedProperties();
		},
	};
	var Pe = W.default.log;
	w.log = Pe;
	w.createFrame = S.createFrame;
	w.logger = W.default;
});
var Wt = h((G, Zt) => {
	'use strict';
	G.__esModule = !0;
	function ct(n) {
		this.string = n;
	}
	ct.prototype.toString = ct.prototype.toHTML = function () {
		return '' + this.string;
	};
	G.default = ct;
	Zt.exports = G.default;
});
var Gt = h((dt) => {
	'use strict';
	dt.__esModule = !0;
	dt.wrapHelper = Ee;
	function Ee(n, t) {
		if (typeof n != 'function') return n;
		var o = function () {
			var a = arguments[arguments.length - 1];
			return (arguments[arguments.length - 1] = t(a)), n.apply(this, arguments);
		};
		return o;
	}
});
var Xt = h((P) => {
	'use strict';
	P.__esModule = !0;
	P.checkRevision = qe;
	P.template = He;
	P.wrapProgram = $;
	P.resolvePartial = Le;
	P.invokePartial = Ie;
	P.noop = Nt;
	function Se(n) {
		return n && n.__esModule ? n : { default: n };
	}
	function Oe(n) {
		if (n && n.__esModule) return n;
		var t = {};
		if (n != null) for (var o in n) Object.prototype.hasOwnProperty.call(n, o) && (t[o] = n[o]);
		return (t.default = n), t;
	}
	var _e = y(),
		O = Oe(_e),
		Me = k(),
		x = Se(Me),
		C = ut(),
		$t = et(),
		Te = Gt(),
		ft = lt();
	function qe(n) {
		var t = (n && n[0]) || 1,
			o = C.COMPILER_REVISION;
		if (!(t >= C.LAST_COMPATIBLE_COMPILER_REVISION && t <= C.COMPILER_REVISION))
			if (t < C.LAST_COMPATIBLE_COMPILER_REVISION) {
				var d = C.REVISION_CHANGES[o],
					a = C.REVISION_CHANGES[t];
				throw new x.default(
					'Template was precompiled with an older version of Handlebars than the current runtime. Please update your precompiler to a newer version (' +
						d +
						') or downgrade your runtime to an older version (' +
						a +
						').',
				);
			} else
				throw new x.default(
					'Template was precompiled with a newer version of Handlebars than the current runtime. Please update your runtime to a newer version (' +
						n[1] +
						').',
				);
	}
	function He(n, t) {
		if (!t) throw new x.default('No environment passed to template');
		if (!n || !n.main) throw new x.default('Unknown template object: ' + typeof n);
		(n.main.decorator = n.main_d), t.VM.checkRevision(n.compiler);
		var o = n.compiler && n.compiler[0] === 7;
		function d(l, i, r) {
			r.hash && ((i = O.extend({}, i, r.hash)), r.ids && (r.ids[0] = !0)),
				(l = t.VM.resolvePartial.call(this, l, i, r)),
				(r.hooks = this.hooks),
				(r.protoAccessControl = this.protoAccessControl);
			var s = t.VM.invokePartial.call(this, l, i, r);
			if (s == null && O.isFunction(l))
				throw new x.default(
					'The partial ' + r.name + ' returned no output: partials must return a string',
				);
			if (s == null && t.compile) {
				if (typeof l != 'string')
					throw new x.default(
						'The partial ' +
							r.name +
							' could not be compiled: partials must be strings or functions returning strings',
					);
				(r.partials[r.name] = t.compile(l, n.compilerOptions, t)), (s = r.partials[r.name](i, r));
			}
			if (s != null) {
				if (r.indent) {
					for (
						var u = s.split(`
`),
							c = 0,
							m = u.length;
						c < m && !(!u[c] && c + 1 === m);
						c++
					)
						u[c] = r.indent + u[c];
					s = u.join(`
`);
				}
				return s;
			} else
				throw new x.default(
					'The partial ' + r.name + ' could not be compiled when running in runtime-only mode',
				);
		}
		var a = {
			strict: function (i, r, s) {
				if (!i || !(r in i)) throw new x.default('"' + r + '" not defined in ' + i, { loc: s });
				return a.lookupProperty(i, r);
			},
			lookupProperty: function (i, r) {
				var s = i[r];
				if (
					s == null ||
					(Object.prototype.hasOwnProperty.call(i, r) && !ft.isPrototypeConstructor(i, r, s)) ||
					ft.resultIsAllowed(s, a.protoAccessControl, r)
				)
					return s;
			},
			lookup: function (i, r) {
				for (var s = i.length, u = 0; u < s; u++) {
					var c = i[u] && a.lookupProperty(i[u], r);
					if (c != null) return c;
				}
			},
			lambda: function (i, r) {
				return typeof i == 'function' ? i.call(r) : i;
			},
			escapeExpression: O.escapeExpression,
			invokePartial: d,
			fn: function (i) {
				var r = n[i];
				return (r.decorator = n[i + '_d']), r;
			},
			programs: [],
			program: function (i, r, s, u, c) {
				var m = this.programs[i],
					f = this.fn(i);
				return (
					r || c || u || s
						? (m = $(this, i, f, r, s, u, c))
						: m || (m = this.programs[i] = $(this, i, f)),
					m
				);
			},
			data: function (i, r) {
				for (; i && r--; ) i = i._parent;
				return i;
			},
			mergeIfNeeded: function (i, r) {
				var s = i || r;
				return i && r && i !== r && (s = O.extend({}, r, i)), s;
			},
			nullContext: Object.seal({}),
			noop: t.VM.noop,
			compilerInfo: n.compiler,
		};
		function e(l) {
			var i = arguments.length <= 1 || arguments[1] === void 0 ? {} : arguments[1],
				r = i.data;
			e._setup(i), !i.partial && n.useData && (r = ze(l, r));
			var s = void 0,
				u = n.useBlockParams ? [] : void 0;
			n.useDepths &&
				(i.depths ? (s = l != i.depths[0] ? [l].concat(i.depths) : i.depths) : (s = [l]));
			function c(m) {
				return '' + n.main(a, m, a.helpers, a.partials, r, u, s);
			}
			return (c = Jt(n.main, c, a, i.depths || [], r, u)), c(l, i);
		}
		return (
			(e.isTop = !0),
			(e._setup = function (l) {
				if (l.partial)
					(a.protoAccessControl = l.protoAccessControl),
						(a.helpers = l.helpers),
						(a.partials = l.partials),
						(a.decorators = l.decorators),
						(a.hooks = l.hooks);
				else {
					var i = {};
					Yt(i, t.helpers, a),
						Yt(i, l.helpers, a),
						(a.helpers = i),
						n.usePartial && (a.partials = a.mergeIfNeeded(l.partials, t.partials)),
						(n.usePartial || n.useDecorators) &&
							(a.decorators = O.extend({}, t.decorators, l.decorators)),
						(a.hooks = {}),
						(a.protoAccessControl = ft.createProtoAccessControl(l));
					var r = l.allowCallsToHelperMissing || o;
					$t.moveHelperToHooks(a, 'helperMissing', r),
						$t.moveHelperToHooks(a, 'blockHelperMissing', r);
				}
			}),
			(e._child = function (l, i, r, s) {
				if (n.useBlockParams && !r) throw new x.default('must pass block params');
				if (n.useDepths && !s) throw new x.default('must pass parent depths');
				return $(a, l, n[l], i, 0, r, s);
			}),
			e
		);
	}
	function $(n, t, o, d, a, e, l) {
		function i(r) {
			var s = arguments.length <= 1 || arguments[1] === void 0 ? {} : arguments[1],
				u = l;
			return (
				l && r != l[0] && !(r === n.nullContext && l[0] === null) && (u = [r].concat(l)),
				o(n, r, n.helpers, n.partials, s.data || d, e && [s.blockParams].concat(e), u)
			);
		}
		return (
			(i = Jt(o, i, n, l, d, e)),
			(i.program = t),
			(i.depth = l ? l.length : 0),
			(i.blockParams = a || 0),
			i
		);
	}
	function Le(n, t, o) {
		return (
			n
				? typeof n != 'function' && !o.name && ((o.name = n), (n = Y(o.partials, n)))
				: o.name === '@partial-block'
					? (n = Y(o.data, 'partial-block'))
					: (n = Y(o.partials, o.name)),
			n
		);
	}
	function Ie(n, t, o) {
		var d = Y(o.data, 'partial-block');
		(o.partial = !0), o.ids && (o.data.contextPath = o.ids[0] || o.data.contextPath);
		var a = void 0;
		if (
			(o.fn &&
				o.fn !== Nt &&
				(function () {
					o.data = C.createFrame(o.data);
					var e = o.fn;
					(a = o.data['partial-block'] =
						function (i) {
							var r = arguments.length <= 1 || arguments[1] === void 0 ? {} : arguments[1];
							return (r.data = C.createFrame(r.data)), (r.data['partial-block'] = d), e(i, r);
						}),
						e.partials && (o.partials = O.extend({}, o.partials, e.partials));
				})(),
			n === void 0 && a && (n = a),
			n === void 0)
		)
			throw new x.default('The partial ' + o.name + ' could not be found');
		if (n instanceof Function) return n(t, o);
	}
	function Nt() {
		return '';
	}
	function Y(n, t) {
		if (n && Object.prototype.hasOwnProperty.call(n, t)) return n[t];
	}
	function ze(n, t) {
		return (!t || !('root' in t)) && ((t = t ? C.createFrame(t) : {}), (t.root = n)), t;
	}
	function Jt(n, t, o, d, a, e) {
		if (n.decorator) {
			var l = {};
			(t = n.decorator(t, l, o, d && d[0], a, e, d)), O.extend(t, l);
		}
		return t;
	}
	function Yt(n, t, o) {
		t &&
			Object.keys(t).forEach(function (d) {
				var a = t[d];
				n[d] = Re(a, o);
			});
	}
	function Re(n, t) {
		var o = t.lookupProperty;
		return Te.wrapHelper(n, function (d) {
			return (d.lookupProperty = o), d;
		});
	}
});
var Qt = h((N, Kt) => {
	'use strict';
	N.__esModule = !0;
	N.default = function (n) {
		(function () {
			typeof globalThis != 'object' &&
				(Object.prototype.__defineGetter__('__magic__', function () {
					return this;
				}),
				(__magic__.globalThis = __magic__),
				delete Object.prototype.__magic__);
		})();
		var t = globalThis.Handlebars;
		n.noConflict = function () {
			return globalThis.Handlebars === n && (globalThis.Handlebars = t), n;
		};
	};
	Kt.exports = N.default;
});
var on = h((J, rn) => {
	'use strict';
	J.__esModule = !0;
	function pt(n) {
		return n && n.__esModule ? n : { default: n };
	}
	function ht(n) {
		if (n && n.__esModule) return n;
		var t = {};
		if (n != null) for (var o in n) Object.prototype.hasOwnProperty.call(n, o) && (t[o] = n[o]);
		return (t.default = n), t;
	}
	var Ue = ut(),
		tn = ht(Ue),
		Ae = Wt(),
		De = pt(Ae),
		Ve = k(),
		Fe = pt(Ve),
		Be = y(),
		mt = ht(Be),
		je = Xt(),
		nn = ht(je),
		Ze = Qt(),
		We = pt(Ze);
	function en() {
		var n = new tn.HandlebarsEnvironment();
		return (
			mt.extend(n, tn),
			(n.SafeString = De.default),
			(n.Exception = Fe.default),
			(n.Utils = mt),
			(n.escapeExpression = mt.escapeExpression),
			(n.VM = nn),
			(n.template = function (t) {
				return nn.template(t, n);
			}),
			n
		);
	}
	var H = en();
	H.create = en;
	We.default(H);
	H.default = H;
	J.default = H;
	rn.exports = J.default;
});
var an = h((tr, ln) => {
	ln.exports = on().default;
});
var b = gn(an());
b.default.registerHelper('eq', (n, t) => n === t);
b.default.registerHelper('includes', (n, t) =>
	Array.isArray(n)
		? n.includes(t)
		: typeof n == 'string' &&
			typeof t == 'string' &&
			n
				.split(',')
				.map((o) => o.trim())
				.includes(t),
);
b.default.registerPartial(
	'formHostNavigation',
	b.default.template({
		0: function (n, t, o, d, a) {
			return `
// Leave for the redirect the form's author configured. The form is finished, so this
// takes the whole tab, which is where a form rendered without the shell ends up too.
function redirectTo(target) {
	if (isShellHosted) requestHostNavigation('n8n-form-redirect', target);
	else window.location.replace(target);
}
`;
		},
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r =
					n.lookupProperty ||
					function (s, u) {
						if (Object.prototype.hasOwnProperty.call(s, u)) return s[u];
					};
			return (
				`// Set only inside the n8n hosting shell's frame: the path prefix whose pages this
// page may hand to the host to navigate to. Empty everywhere else.
const hostNavigationPath = '` +
				n.escapeExpression(
					((l =
						(l = r(o, 'path') || (t != null ? r(t, 'path') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(i, {
								name: 'path',
								hash: {},
								data: a,
								loc: { start: { line: 3, column: 28 }, end: { line: 3, column: 36 } },
							})
						: l),
				) +
				`';
const isShellHosted = window.parent !== window && !!hostNavigationPath;

// True for this form's own follow-up pages, the only ones the shell will move to.
function isHostNavigable(target) {
	if (!hostNavigationPath) return false;
	try {
		const here = new URL(window.location.href);
		const resolved = new URL(target, here);
		if (resolved.origin !== here.origin) return false;
		return resolved.pathname === hostNavigationPath
			|| resolved.pathname.startsWith(hostNavigationPath + '/');
	} catch (e) {
		return false;
	}
}

// Ask the host for a move this document can't make itself: inside the shell it is
// sandboxed to an opaque origin, so a navigation it starts counts as cross-site and
// the browser withholds the form's own auth cookie. The shell runs on the real
// origin, so the move it makes for us keeps the cookie. \`type\` says which move \u2014
// another page of this form inside the frame, or the author's redirect for the tab.
function requestHostNavigation(type, target) {
	// targetOrigin '*': an opaque-origin document cannot name its parent's origin,
	// and the payload is only a URL the parent can already read.
	window.parent.postMessage({ type, url: String(target) }, '*');
}

// Move to another page of this form.
function navigateTo(target) {
	if (isShellHosted && isHostNavigable(target)) requestHostNavigation('n8n-form-navigate', target);
	else window.location.replace(target);
}
` +
				((e = r(o, 'if').call(i, t != null ? r(t, 'withRedirect') : t, {
					name: 'if',
					hash: {},
					fn: n.program(0, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 36, column: 0 }, end: { line: 44, column: 7 } },
				})) != null
					? e
					: '')
			);
		},
		useData: !0,
	}),
);
var sn = {
	'form-invalid-token': b.default.template({
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a) {
			return `<!DOCTYPE html>
<html lang='en'>

<head>
  <meta charset='UTF-8' />
  <meta name='viewport' content='width=device-width, initial-scale=1.0' />
  <link rel='icon' type='image/png' href='https://n8n.io/favicon.ico' />
  <link href='https://fonts.googleapis.com/css?family=Open+Sans' rel='stylesheet' type='text/css' />
  <title>Invalid Form Link</title>
  <style>
    :root {
      /* Fonts */
      --font-family: 'Open Sans', sans-serif;
      --font-weight-normal: 400;
      --font-weight-bold: 600;
      --font-size-body: 12px;
      --font-size-link: 12px;
      --font-size-header: 20px;
      --font-size-subheader: 14px;

      /* Colors */
      --color-background: #FBFCFE;
      --color-card-bg: white;
      --color-card-border: #DBDFE7;
      --color-card-shadow: #634DFF0F;
      --color-link: #7E8186;
      --color-header: #525356;
      --color-header-subtext: #7E8186;

      /* Spacing & dimensions */
      --padding-container-top: 24px;
      --container-width: 448px;
      --card-padding: 24px;
      --card-border-radius: 8px;
      --card-margin-bottom: 16px;
    }

    *,
    ::after,
    ::before {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-family);
      font-weight: var(--font-weight-normal);
      font-size: var(--font-size-body);
      display: flex;
      flex-direction: column;
      justify-content: start;
      background-color: var(--color-background);
    }

    .container {
      margin: auto;
      text-align: center;
      padding-top: var(--padding-container-top);
      width: var(--container-width);
    }

    .card {
      padding: var(--card-padding);
      background-color: var(--color-card-bg);
      border: 1px solid var(--color-card-border);
      border-radius: var(--card-border-radius);
      box-shadow: 0px 4px 16px 0px var(--color-card-shadow);
      margin-bottom: var(--card-margin-bottom);
    }

    .n8n-link a {
      color: var(--color-link);
      font-weight: var(--font-weight-bold);
      font-size: var(--font-size-link);
      text-decoration: none;
    }

    .n8n-link svg {
      display: inline-block;
      vertical-align: middle;
    }

    .header h1 {
      color: var(--color-header);
      font-size: var(--font-size-header);
      font-weight: var(--font-weight-normal);
      padding-bottom: 8px;
    }

    .header p {
      color: var(--color-header-subtext);
      font-size: var(--font-size-subheader);
      font-weight: var(--font-weight-normal);
    }
  </style>
</head>

<body>
  <div class='container'>
    <section>
      <div class='card'>
        <div class='header'>
          <h1>Invalid Form Link</h1>
          <p>This form link is invalid or has expired. Please request a new link.</p>
        </div>
      </div>
      <div class='n8n-link'>
        <a href='https://n8n.io/?utm_source=n8n-internal&amp;utm_medium=form-trigger&amp' target='_blank' rel='noopener noreferrer'>
          Form automated with
          <svg width='73' height='20' viewBox='0 0 73 20' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path fill-rule='evenodd' clip-rule='evenodd'
              d='M40.2373 4C40.2373 6.20915 38.4464 8 36.2373 8C34.3735 8 32.8074 6.72525 32.3633 5H26.7787C25.801 5 24.9666 5.70685 24.8059 6.6712L24.6415 7.6576C24.4854 8.59415 24.0116 9.40925 23.3417 10C24.0116 10.5907 24.4854 11.4058 24.6415 12.3424L24.8059 13.3288C24.9666 14.2931 25.801 15 26.7787 15H28.3633C28.8074 13.2747 30.3735 12 32.2373 12C34.4464 12 36.2373 13.7908 36.2373 16C36.2373 18.2092 34.4464 20 32.2373 20C30.3735 20 28.8074 18.7253 28.3633 17H26.7787C24.8233 17 23.1546 15.5864 22.8331 13.6576L22.6687 12.6712C22.508 11.7069 21.6736 11 20.6959 11H19.0645C18.5652 12.64 17.0406 13.8334 15.2373 13.8334C13.434 13.8334 11.9094 12.64 11.4101 11H9.06449C8.56519 12.64 7.04059 13.8334 5.2373 13.8334C3.02817 13.8334 1.2373 12.0424 1.2373 9.83335C1.2373 7.6242 3.02817 5.83335 5.2373 5.83335C7.16069 5.83335 8.76699 7.19085 9.15039 9H11.3242C11.7076 7.19085 13.3139 5.83335 15.2373 5.83335C17.1607 5.83335 18.767 7.19085 19.1504 9H20.6959C21.6736 9 22.508 8.29315 22.6687 7.3288L22.8331 6.3424C23.1546 4.41365 24.8233 3 26.7787 3H32.3633C32.8074 1.27478 34.3735 0 36.2373 0C38.4464 0 40.2373 1.79086 40.2373 4ZM38.2373 4C38.2373 5.10455 37.3419 6 36.2373 6C35.1327 6 34.2373 5.10455 34.2373 4C34.2373 2.89543 35.1327 2 36.2373 2C37.3419 2 38.2373 2.89543 38.2373 4ZM5.2373 11.8334C6.34189 11.8334 7.23729 10.9379 7.23729 9.83335C7.23729 8.72875 6.34189 7.83335 5.2373 7.83335C4.13273 7.83335 3.2373 8.72875 3.2373 9.83335C3.2373 10.9379 4.13273 11.8334 5.2373 11.8334ZM15.2373 11.8334C16.3419 11.8334 17.2373 10.9379 17.2373 9.83335C17.2373 8.72875 16.3419 7.83335 15.2373 7.83335C14.1327 7.83335 13.2373 8.72875 13.2373 9.83335C13.2373 10.9379 14.1327 11.8334 15.2373 11.8334ZM32.2373 18C33.3419 18 34.2373 17.1045 34.2373 16C34.2373 14.8954 33.3419 14 32.2373 14C31.1327 14 30.2373 14.8954 30.2373 16C30.2373 17.1045 31.1327 18 32.2373 18Z'
              fill='#EA4B71'></path>
            <path
              d='M44.2393 15.0007H46.3277V10.5791C46.3277 9.12704 47.2088 8.49074 48.204 8.49074C49.183 8.49074 49.9498 9.14334 49.9498 10.4812V15.0007H52.038V10.057C52.038 7.91969 50.798 6.67969 48.8567 6.67969C47.633 6.67969 46.9477 7.16914 46.4582 7.80544H46.3277L46.1482 6.84284H44.2393V15.0007Z'
              fill='#101330'></path>
            <path
              d='M60.0318 9.50205V9.40415C60.7498 9.0452 61.4678 8.4252 61.4678 7.20155C61.4678 5.43945 60.0153 4.37891 58.0088 4.37891C55.9528 4.37891 54.4843 5.5047 54.4843 7.23415C54.4843 8.4089 55.1698 9.0452 55.9203 9.40415V9.50205C55.0883 9.79575 54.0928 10.6768 54.0928 12.1452C54.0928 13.9237 55.5613 15.1637 57.9923 15.1637C60.4233 15.1637 61.8428 13.9237 61.8428 12.1452C61.8428 10.6768 60.8638 9.81205 60.0318 9.50205ZM57.9923 5.87995C58.8083 5.87995 59.4118 6.40205 59.4118 7.2831C59.4118 8.16415 58.7918 8.6863 57.9923 8.6863C57.1928 8.6863 56.5238 8.16415 56.5238 7.2831C56.5238 6.38575 57.1603 5.87995 57.9923 5.87995ZM57.9923 13.5974C57.0458 13.5974 56.2793 12.9937 56.2793 11.9658C56.2793 11.0358 56.9153 10.3342 57.9758 10.3342C59.0203 10.3342 59.6568 11.0195 59.6568 11.9984C59.6568 12.9937 58.9223 13.5974 57.9923 13.5974Z'
              fill='#101330'></path>
            <path
              d='M63.9639 15.0007H66.0524V10.5791C66.0524 9.12704 66.9334 8.49074 67.9289 8.49074C68.9079 8.49074 69.6744 9.14334 69.6744 10.4812V15.0007H71.7629V10.057C71.7629 7.91969 70.5229 6.67969 68.5814 6.67969C67.3579 6.67969 66.6724 7.16914 66.1829 7.80544H66.0524L65.8729 6.84284H63.9639V15.0007Z'
              fill='#101330'></path>
          </svg>
        </a>
      </div>
    </section>
  </div>
</body>

</html>
`;
		},
		useData: !0,
	}),
	'form-shell': b.default.template({
		0: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r = n.hooks.helperMissing,
				s = 'function',
				u = n.escapeExpression,
				c =
					n.lookupProperty ||
					function (m, f) {
						if (Object.prototype.hasOwnProperty.call(m, f)) return m[f];
					};
			return (
				`		<div
			class='cred-row'
			data-cred-id='` +
				u(
					((l = (l = c(o, 'id') || (t != null ? c(t, 'id') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 151, column: 17 }, end: { line: 151, column: 23 } },
							})
						: l),
				) +
				`'
			data-status='` +
				u(
					((l = (l = c(o, 'status') || (t != null ? c(t, 'status') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'status',
								hash: {},
								data: a,
								loc: { start: { line: 152, column: 16 }, end: { line: 152, column: 26 } },
							})
						: l),
				) +
				`'
			data-resolver-id='` +
				u(
					((l = (l = c(o, 'resolverId') || (t != null ? c(t, 'resolverId') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'resolverId',
								hash: {},
								data: a,
								loc: { start: { line: 153, column: 21 }, end: { line: 153, column: 35 } },
							})
						: l),
				) +
				`'
			data-not-connected-text='` +
				u(
					((l =
						(l = c(o, 'notConnectedText') || (t != null ? c(t, 'notConnectedText') : t)) != null
							? l
							: r),
					typeof l === s
						? l.call(i, {
								name: 'notConnectedText',
								hash: {},
								data: a,
								loc: { start: { line: 154, column: 28 }, end: { line: 154, column: 48 } },
							})
						: l),
				) +
				`'
			` +
				((e = c(o, 'if').call(i, t != null ? c(t, 'connected') : t, {
					name: 'if',
					hash: {},
					fn: n.program(1, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 155, column: 3 }, end: { line: 155, column: 49 } },
				})) != null
					? e
					: '') +
				`
			` +
				((e = c(o, 'if').call(i, t != null ? c(t, 'revokeUrl') : t, {
					name: 'if',
					hash: {},
					fn: n.program(2, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 156, column: 3 }, end: { line: 156, column: 59 } },
				})) != null
					? e
					: '') +
				`
		>
` +
				((e = c(o, 'if').call(i, t != null ? c(t, 'iconUrl') : t, {
					name: 'if',
					hash: {},
					fn: n.program(3, a, 0),
					inverse: n.program(4, a, 0),
					data: a,
					loc: { start: { line: 159, column: 3 }, end: { line: 163, column: 10 } },
				})) != null
					? e
					: '') +
				`			<span class='cred-meta'>
				<span class='cred-name'>` +
				u(
					((l = (l = c(o, 'name') || (t != null ? c(t, 'name') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'name',
								hash: {},
								data: a,
								loc: { start: { line: 165, column: 28 }, end: { line: 165, column: 36 } },
							})
						: l),
				) +
				`</span>
				<span class='cred-sub'>` +
				((e = c(o, 'if').call(i, t != null ? c(t, 'connected') : t, {
					name: 'if',
					hash: {},
					fn: n.program(5, a, 0),
					inverse: n.program(8, a, 0),
					data: a,
					loc: { start: { line: 166, column: 27 }, end: { line: 166, column: 142 } },
				})) != null
					? e
					: '') +
				((e = c(o, 'if').call(i, t != null ? c(t, 'usedBy') : t, {
					name: 'if',
					hash: {},
					fn: n.program(9, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 166, column: 142 }, end: { line: 166, column: 184 } },
				})) != null
					? e
					: '') +
				`</span>
			</span>
` +
				((e = c(o, 'if').call(i, t != null ? c(t, 'connected') : t, {
					name: 'if',
					hash: {},
					fn: n.program(10, a, 0),
					inverse: n.program(11, a, 0),
					data: a,
					loc: { start: { line: 168, column: 3 }, end: { line: 174, column: 10 } },
				})) != null
					? e
					: '') +
				`		</div>
`
			);
		},
		1: function (n, t, o, d, a) {
			return " data-connected='true'";
		},
		2: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				" data-revoke-url='" +
				n.escapeExpression(
					((e =
						(e = l(o, 'revokeUrl') || (t != null ? l(t, 'revokeUrl') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'revokeUrl',
								hash: {},
								data: a,
								loc: { start: { line: 156, column: 38 }, end: { line: 156, column: 51 } },
							})
						: e),
				) +
				"'"
			);
		},
		3: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				"				<img class='cred-icon cred-icon-img' src='" +
				s(
					((e = (e = u(o, 'iconUrl') || (t != null ? u(t, 'iconUrl') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'iconUrl',
								hash: {},
								data: a,
								loc: { start: { line: 160, column: 46 }, end: { line: 160, column: 57 } },
							})
						: e),
				) +
				"' alt='' data-initial='" +
				s(
					((e = (e = u(o, 'initial') || (t != null ? u(t, 'initial') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'initial',
								hash: {},
								data: a,
								loc: { start: { line: 160, column: 80 }, end: { line: 160, column: 91 } },
							})
						: e),
				) +
				`' />
`
			);
		},
		4: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"				<span class='cred-icon'>" +
				n.escapeExpression(
					((e =
						(e = l(o, 'initial') || (t != null ? l(t, 'initial') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'initial',
								hash: {},
								data: a,
								loc: { start: { line: 162, column: 28 }, end: { line: 162, column: 39 } },
							})
						: e),
				) +
				`</span>
`
			);
		},
		5: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (e = l(o, 'if').call(t ?? (n.nullContext || {}), t != null ? l(t, 'account') : t, {
				name: 'if',
				hash: {},
				fn: n.program(6, a, 0),
				inverse: n.program(7, a, 0),
				data: a,
				loc: { start: { line: 166, column: 44 }, end: { line: 166, column: 107 } },
			})) != null
				? e
				: '';
		},
		6: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				'Connected as ' +
				n.escapeExpression(
					((e =
						(e = l(o, 'account') || (t != null ? l(t, 'account') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'account',
								hash: {},
								data: a,
								loc: { start: { line: 166, column: 72 }, end: { line: 166, column: 83 } },
							})
						: e),
				)
			);
		},
		7: function (n, t, o, d, a) {
			return 'Connected';
		},
		8: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return n.escapeExpression(
				((e =
					(e = l(o, 'notConnectedText') || (t != null ? l(t, 'notConnectedText') : t)) != null
						? e
						: n.hooks.helperMissing),
				typeof e == 'function'
					? e.call(t ?? (n.nullContext || {}), {
							name: 'notConnectedText',
							hash: {},
							data: a,
							loc: { start: { line: 166, column: 115 }, end: { line: 166, column: 135 } },
						})
					: e),
			);
		},
		9: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				' \xB7 used by ' +
				n.escapeExpression(
					((e =
						(e = l(o, 'usedBy') || (t != null ? l(t, 'usedBy') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'usedBy',
								hash: {},
								data: a,
								loc: { start: { line: 166, column: 167 }, end: { line: 166, column: 177 } },
							})
						: e),
				)
			);
		},
		10: function (n, t, o, d, a) {
			return `				<span class='cred-connected'><button type='button' class='btn-connected'><span class='dot'></span> Connected <span class='caret'>&#9662;</span></button><div class='cred-menu'><button type='button' class='btn-disconnect'>Disconnect</button></div></span>
`;
		},
		11: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (e = l(o, 'if').call(
				t ?? (n.nullContext || {}),
				t != null ? l(t, 'authorizationUrl') : t,
				{
					name: 'if',
					hash: {},
					fn: n.program(12, a, 0),
					inverse: n.program(15, a, 0),
					data: a,
					loc: { start: { line: 170, column: 3 }, end: { line: 174, column: 3 } },
				},
			)) != null
				? e
				: '';
		},
		12: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r = n.hooks.helperMissing,
				s =
					n.lookupProperty ||
					function (u, c) {
						if (Object.prototype.hasOwnProperty.call(u, c)) return u[c];
					};
			return (
				"				<button class='btn btn-secondary connect' data-url='" +
				n.escapeExpression(
					((l =
						(l = s(o, 'authorizationUrl') || (t != null ? s(t, 'authorizationUrl') : t)) != null
							? l
							: r),
					typeof l == 'function'
						? l.call(i, {
								name: 'authorizationUrl',
								hash: {},
								data: a,
								loc: { start: { line: 171, column: 56 }, end: { line: 171, column: 76 } },
							})
						: l),
				) +
				"'>" +
				((e = s(o, 'if').call(
					i,
					(s(o, 'eq') || (t && s(t, 'eq')) || r).call(
						i,
						t != null ? s(t, 'status') : t,
						'expired',
						{
							name: 'eq',
							hash: {},
							data: a,
							loc: { start: { line: 171, column: 84 }, end: { line: 171, column: 105 } },
						},
					),
					{
						name: 'if',
						hash: {},
						fn: n.program(13, a, 0),
						inverse: n.program(14, a, 0),
						data: a,
						loc: { start: { line: 171, column: 78 }, end: { line: 171, column: 138 } },
					},
				)) != null
					? e
					: '') +
				`</button>
`
			);
		},
		13: function (n, t, o, d, a) {
			return 'Reconnect';
		},
		14: function (n, t, o, d, a) {
			return 'Connect';
		},
		15: function (n, t, o, d, a) {
			return `				<span class='cred-blocked'>Ask the form owner</span>
			`;
		},
		16: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r =
					n.lookupProperty ||
					function (s, u) {
						if (Object.prototype.hasOwnProperty.call(s, u)) return s[u];
					};
			return (
				"			<div class='req-summary" +
				((e = r(o, 'if').call(i, t != null ? r(t, 'allConnected') : t, {
					name: 'if',
					hash: {},
					fn: n.program(17, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 180, column: 26 }, end: { line: 180, column: 67 } },
				})) != null
					? e
					: '') +
				`' id='req-summary'>
				<span class='summary-info' id='summary-info'>
					<button type='button' class='summary-icon' aria-describedby='summary-tooltip' aria-label='About the accounts this form uses'>
						<svg class='icon-pending' width='17' height='17' viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.3' aria-hidden='true'><circle cx='8' cy='8' r='6.7' /><path d='M8 7.3v3.5' stroke-linecap='round' /><circle cx='8' cy='5.1' r='.8' fill='currentColor' stroke='none' /></svg>
						<svg class='icon-ok' width='17' height='17' viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.3' aria-hidden='true'><circle cx='8' cy='8' r='6.7' /><path d='m5.2 8.2 1.9 1.9 3.7-4' stroke-linecap='round' stroke-linejoin='round' /></svg>
					</button>
					<span class='summary-tooltip' role='tooltip' id='summary-tooltip'>
						<span class='summary-tooltip-body'>Submitting this form runs actions on your behalf, using accounts you connect. You can disconnect them at any time. <a href='https://docs.n8n.io/administer/manage-credentials/end-user-credentials' target='_blank' rel='noopener noreferrer'>Learn more</a></span>
					</span>
				</span>
				<span class='summary-text' id='summary-text'>` +
				n.escapeExpression(
					((l =
						(l = r(o, 'summaryText') || (t != null ? r(t, 'summaryText') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(i, {
								name: 'summaryText',
								hash: {},
								data: a,
								loc: { start: { line: 190, column: 49 }, end: { line: 190, column: 64 } },
							})
						: l),
				) +
				`</span>
				<button class='btn btn-primary' id='open-dialog'><span class='dot'></span><span class='label'>` +
				((e = r(o, 'if').call(i, t != null ? r(t, 'allConnected') : t, {
					name: 'if',
					hash: {},
					fn: n.program(18, a, 0),
					inverse: n.program(14, a, 0),
					data: a,
					loc: { start: { line: 191, column: 98 }, end: { line: 191, column: 146 } },
				})) != null
					? e
					: '') +
				`</span></button>
			</div>
`
			);
		},
		17: function (n, t, o, d, a) {
			return ' all-connected';
		},
		18: function (n, t, o, d, a) {
			return 'Manage';
		},
		19: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				`			<div class='req-card'>
` +
				((e = l(o, 'each').call(t ?? (n.nullContext || {}), t != null ? l(t, 'credentials') : t, {
					name: 'each',
					hash: {},
					fn: n.program(20, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 195, column: 4 }, end: { line: 197, column: 13 } },
				})) != null
					? e
					: '') +
				`			</div>
`
			);
		},
		20: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (e = n.invokePartial(l(d, 'credRow'), t, {
				name: 'credRow',
				hash: { notConnectedText: 'Not connected \xB7 needed to submit this form' },
				data: a,
				indent: '					',
				helpers: o,
				partials: d,
				decorators: n.decorators,
			})) != null
				? e
				: '';
		},
		21: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r =
					n.lookupProperty ||
					function (s, u) {
						if (Object.prototype.hasOwnProperty.call(s, u)) return s[u];
					};
			return (
				`		<div class='overlay' id='overlay'>
			<div class='dialog' role='dialog' aria-modal='true' aria-labelledby='dialog-title'>
				<div class='dialog-head'>
					<span class='dialog-title' id='dialog-title'>Connect your accounts</span>
					<button class='dialog-close' id='close-dialog' aria-label='Close'>&times;</button>
				</div>
				<div class='dialog-sub'>Submitting this form uses these accounts on your behalf.</div>
				<div class='dialog-list'>
` +
				((e = r(o, 'each').call(i, t != null ? r(t, 'credentials') : t, {
					name: 'each',
					hash: {},
					fn: n.program(22, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 217, column: 5 }, end: { line: 219, column: 14 } },
				})) != null
					? e
					: '') +
				`				</div>
				<div class='dialog-foot'>
					<span class='dialog-count' id='dialog-count'>` +
				n.escapeExpression(
					((l =
						(l = r(o, 'footerText') || (t != null ? r(t, 'footerText') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(i, {
								name: 'footerText',
								hash: {},
								data: a,
								loc: { start: { line: 222, column: 50 }, end: { line: 222, column: 64 } },
							})
						: l),
				) +
				`</span>
					<button class='btn btn-primary' id='done-dialog'>Done</button>
				</div>
			</div>
		</div>
`
			);
		},
		22: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (e = n.invokePartial(l(d, 'credRow'), t, {
				name: 'credRow',
				hash: { notConnectedText: 'Not connected' },
				data: a,
				indent: '						',
				helpers: o,
				partials: d,
				decorators: n.decorators,
			})) != null
				? e
				: '';
		},
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a, e, l) {
			var i,
				r,
				s = t ?? (n.nullContext || {}),
				u = n.hooks.helperMissing,
				c = 'function',
				m = n.escapeExpression,
				f =
					n.lookupProperty ||
					function (p, g) {
						if (Object.prototype.hasOwnProperty.call(p, g)) return p[g];
					};
			return (
				`<!DOCTYPE html>
<html lang='en'>
<!--
	Form trigger \u2014 trusted hosting shell: n8n-controlled connect panel on the real
	origin; the author's form renders unchanged in the sandboxed null-origin iframe
	so author content can never touch the per-caller authorize links.
-->

<head>
	<meta charset='UTF-8' />
	<meta name='viewport' content='width=device-width, initial-scale=1.0' />
	<link rel='icon' type='image/png' href='https://n8n.io/favicon.ico' />
	<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
	<title>` +
				m(
					((r = (r = f(o, 'formTitle') || (t != null ? f(t, 'formTitle') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'formTitle',
								hash: {},
								data: a,
								loc: { start: { line: 14, column: 8 }, end: { line: 14, column: 21 } },
							})
						: r),
				) +
				`</title>
	<style>
		:root {
			--font-family: 'Open Sans', sans-serif;
			--color-background: #fbfcfe;
			--color-card-bg: #ffffff;
			--color-card-border: #dbdfe7;
			--color-card-shadow: rgba(99, 77, 255, 0.06);
			--color-header: #525356;
			--color-label: #555555;
			--color-muted: #7e8186;
			--color-primary: #ff6d5a;
			--color-primary-text: #ffffff;
			--color-ok: #2e9e5b;
			--color-icon-bg: #f2f0ff;
			--color-icon-text: #6a5bdd;
			--border-radius-card: 8px;
			--border-radius-input: 6px;
			/* Matches the form card's own --container-width so the panel and the card
			   line up edge to edge; the narrow-viewport rule below mirrors the form's. */
			--container-width: 448px;
			--box-shadow-card: 0px 4px 16px 0px var(--color-card-shadow);
			--box-shadow-dialog: 0px 12px 48px rgba(0, 0, 0, 0.18);
		}
		*, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; }
		body { font-family: var(--font-family); background: var(--color-background); min-height: 100vh; }
		.shell { width: 100%; padding-top: 24px; }
		.req-card, .req-summary { width: var(--container-width); margin: 0 auto 16px; }

		/* --- Single-account panel: the credential row connects directly --- */
		.req-card {
			background: var(--color-card-bg);
			border: 1px solid var(--color-card-border);
			border-radius: var(--border-radius-card);
			box-shadow: var(--box-shadow-card);
			padding: 8px 20px;
		}

		/* --- Summary line (two or more accounts, details behind the dialog) --- */
		.req-summary {
			display: flex;
			align-items: center;
			gap: 12px;
			background: var(--color-card-bg);
			border: 1px solid var(--color-card-border);
			border-radius: var(--border-radius-card);
			box-shadow: var(--box-shadow-card);
			padding: 14px 18px;
		}
		.summary-info { position: relative; display: flex; flex-shrink: 0; }
		.summary-icon { display: flex; background: none; border: 0; padding: 0; cursor: pointer; color: var(--color-muted); }
		.summary-icon svg { display: block; }
		.summary-icon .icon-ok, .req-summary.all-connected .summary-icon .icon-pending { display: none; }
		.req-summary.all-connected .summary-icon { color: var(--color-ok); }
		.req-summary.all-connected .summary-icon .icon-ok { display: block; }
		/* Hover/focus for pointer + keyboard; \`.open\` is the tap toggle (iOS Safari
		   doesn't focus buttons on tap, so :focus-within alone won't show it there). */
		.summary-tooltip { display: none; position: absolute; top: 100%; left: -12px; padding-top: 8px; width: min(300px, calc(100vw - 32px)); z-index: 20; }
		.summary-info:hover .summary-tooltip, .summary-info:focus-within .summary-tooltip, .summary-info.open .summary-tooltip { display: block; }
		.summary-tooltip-body { display: block; background: var(--color-card-bg); border: 1px solid var(--color-card-border); border-radius: var(--border-radius-card); box-shadow: var(--box-shadow-dialog); padding: 10px 12px; font-size: 12px; line-height: 1.5; color: var(--color-label); }
		.summary-tooltip-body a { color: var(--color-primary); font-weight: 600; text-decoration: none; white-space: nowrap; }
		.summary-tooltip-body a:hover { text-decoration: underline; }
		.summary-text { flex: 1; min-width: 0; font-size: 13px; color: var(--color-header); }

		/* --- Credential row (shared by the single-account panel + dialog) --- */
		.cred-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; }
		.cred-icon {
			width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0;
			background: var(--color-icon-bg); color: var(--color-icon-text);
			font-size: 13px; font-weight: 600; display: flex; align-items: center; justify-content: center;
		}
		/* Provider icon, served unauthenticated from /icons/** on this same origin. */
		img.cred-icon { background: none; object-fit: contain; }
		.cred-meta { flex: 1; min-width: 0; }
		.cred-name { display: block; font-size: 14px; font-weight: 600; color: var(--color-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		/* Stays muted when connected \u2014 the green lives on the row's control, not the copy. */
		.cred-sub { display: block; font-size: 12px; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

		/* --- Buttons --- */
		.btn {
			font-family: var(--font-family); font-size: 13px; font-weight: 600;
			padding: 8px 16px; border-radius: var(--border-radius-input); border: 1px solid transparent; cursor: pointer;
			flex-shrink: 0;
		}
		.btn-primary { background: var(--color-primary); color: var(--color-primary-text); }
		.btn-primary:hover { opacity: 0.88; }
		.btn-secondary { background: var(--color-card-bg); color: var(--color-label); border-color: var(--color-card-border); }
		.btn-secondary:hover { border-color: var(--color-muted); }
		/* Connect (primary) while accounts are outstanding; Manage (quiet) once they're all in. */
		#open-dialog { display: inline-flex; align-items: center; gap: 6px; }
		#open-dialog .dot { display: none; width: 7px; height: 7px; border-radius: 50%; background: var(--color-ok); }
		.req-summary.all-connected #open-dialog { background: var(--color-card-bg); color: var(--color-label); border-color: var(--color-card-border); }
		.req-summary.all-connected #open-dialog:hover { opacity: 1; border-color: var(--color-muted); }
		.req-summary.all-connected #open-dialog .dot { display: block; }
		.cred-connected { position: relative; }
		/* Bordered like the Connect button it replaces, so the row's control keeps its shape. */
		.btn-connected {
			display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
			background: var(--color-card-bg); border: 1px solid var(--color-card-border); border-radius: var(--border-radius-input);
			color: var(--color-label); font-family: var(--font-family); font-size: 13px; font-weight: 600; padding: 8px 12px;
		}
		.btn-connected:hover { border-color: var(--color-muted); }
		.btn-connected .caret { color: var(--color-muted); }
		.btn-connected .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-ok); }
		/* Fixed so the menu escapes the dialog's overflow clipping; positioned by JS. */
		.cred-menu { display: none; position: fixed; min-width: 150px; background: var(--color-card-bg); border: 1px solid var(--color-card-border); border-radius: 6px; box-shadow: var(--box-shadow-dialog); z-index: 30; }
		.cred-menu.open { display: block; }
		.btn-disconnect { display: block; width: 100%; text-align: left; white-space: nowrap; background: none; border: 0; padding: 8px 14px; font-family: var(--font-family); font-size: 13px; color: #a02f28; cursor: pointer; }
		.btn-disconnect:hover { background: #fdeceb; }
		.cred-blocked { font-size: 13px; color: var(--color-muted); }

		/* --- Dialog --- */
		.overlay { display: none; position: fixed; inset: 0; background: rgba(20, 20, 30, 0.28); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); align-items: center; justify-content: center; z-index: 10; padding: 16px; }
		.overlay.open { display: flex; }
		.dialog { width: 448px; max-width: 100%; max-height: calc(100vh - 48px); display: flex; flex-direction: column; background: var(--color-card-bg); border-radius: 12px; box-shadow: var(--box-shadow-dialog); overflow: hidden; }
		.dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px 8px; }
		.dialog-title { font-size: 16px; font-weight: 600; color: var(--color-header); }
		.dialog-close { background: none; border: 0; font-size: 20px; line-height: 1; color: var(--color-muted); cursor: pointer; }
		.dialog-sub { padding: 0 20px 16px; font-size: 13px; color: var(--color-muted); }
		.dialog-list { padding: 0 20px; overflow-y: auto; }
		.dialog-foot { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-top: 1px solid #f0f1f4; }
		.dialog-count { font-size: 13px; color: var(--color-muted); }

		/* --- The form itself, unchanged, in a null-origin sandboxed iframe --- */
		#form-frame { display: block; width: 100%; height: calc(100vh - 40px); border: 0; background: transparent; }

		/* Mirrors the form card's own narrow-viewport width so the edges stay aligned. */
		@media only screen and (max-width: 500px) {
			.req-card, .req-summary { width: 95%; }
		}
	</style>
</head>

<body>

	<div class='shell' data-submitter-email='` +
				m(
					((r =
						(r = f(o, 'submitterEmail') || (t != null ? f(t, 'submitterEmail') : t)) != null
							? r
							: u),
					typeof r === c
						? r.call(s, {
								name: 'submitterEmail',
								hash: {},
								data: a,
								loc: { start: { line: 178, column: 42 }, end: { line: 178, column: 60 } },
							})
						: r),
				) +
				`'>
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'useDialog') : t, {
					name: 'if',
					hash: {},
					fn: n.program(16, a, 0, e, l),
					inverse: n.program(19, a, 0, e, l),
					data: a,
					loc: { start: { line: 179, column: 2 }, end: { line: 199, column: 9 } },
				})) != null
					? i
					: '') +
				`
		<iframe
			id='form-frame'
			src='` +
				m(
					((r = (r = f(o, 'iframeSrc') || (t != null ? f(t, 'iframeSrc') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'iframeSrc',
								hash: {},
								data: a,
								loc: { start: { line: 203, column: 8 }, end: { line: 203, column: 21 } },
							})
						: r),
				) +
				`'
			sandbox='allow-scripts allow-forms allow-modals allow-popups allow-downloads'
		></iframe>
	</div>

` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'useDialog') : t, {
					name: 'if',
					hash: {},
					fn: n.program(21, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 208, column: 1 }, end: { line: 227, column: 8 } },
				})) != null
					? i
					: '') +
				`
	<script>
		(function () {
			// Rows update in place \u2014 a reload would bounce the submitter back through consent.
			var frame = document.getElementById('form-frame');
			var ids = {};
			var connected = {};
			document.querySelectorAll('.cred-row').forEach(function (row) {
				var id = row.getAttribute('data-cred-id');
				ids[id] = true;
				if (row.getAttribute('data-connected') === 'true') connected[id] = true;
			});
			var total = Object.keys(ids).length;

			function accountsLabel(count) { return count === 1 ? 'account' : 'accounts'; }

			// Mirrors \`formShellSummaryText\` in nodes-base/nodes/Form/utils/utils.ts,
			// which renders the same line server-side and is what the unit tests cover.
			function summaryText(count) {
				var remaining = total - count;
				if (remaining <= 0) return 'All ' + total + ' accounts connected \xB7 ready to submit';
				if (count === 0) return total + ' accounts needed to submit this form';
				return remaining + ' more ' + accountsLabel(remaining) + ' needed to submit this form';
			}

			var summaryEl = document.getElementById('summary-text');
			var summaryRow = document.getElementById('req-summary');
			var countEl = document.getElementById('dialog-count');
			var openBtnLabel = document.querySelector('#open-dialog .label');

			function refresh() {
				var count = Object.keys(connected).length;
				var allConnected = count >= total;
				if (summaryEl) summaryEl.textContent = summaryText(count);
				if (summaryRow) summaryRow.classList.toggle('all-connected', allConnected);
				if (openBtnLabel) openBtnLabel.textContent = allConnected ? 'Manage' : 'Connect';
				if (countEl) countEl.textContent = count + ' of ' + total + ' ' + accountsLabel(total) + ' connected';
				// UX-only signal to the form iframe; the server-side POST gate is the guarantee.
				if (frame && frame.contentWindow) {
					frame.contentWindow.postMessage(
						{ type: allConnected ? 'n8n-shell-credentials-ready' : 'n8n-shell-credentials-not-ready' },
						'*',
					);
				}
			}

			if (frame) frame.addEventListener('load', refresh);

			var shellEl = document.querySelector('.shell');
			var SUBMITTER_EMAIL = shellEl ? shellEl.getAttribute('data-submitter-email') || '' : '';
			var CONNECTED_MENU_HTML =
				'<button type="button" class="btn-connected"><span class="dot"></span> Connected <span class="caret">&#9662;</span></button>' +
				'<div class="cred-menu"><button type="button" class="btn-disconnect">Disconnect</button></div>';

			// A provider icon that 404s (renamed node package, stale path) falls back to
			// the letter tile the row also carries.
			function fallBackToLetterTile(img) {
				if (!img || !img.classList || !img.classList.contains('cred-icon-img')) return;
				var tile = document.createElement('span');
				tile.className = 'cred-icon';
				tile.textContent = img.getAttribute('data-initial') || '?';
				img.replaceWith(tile);
			}
			// Capture phase because \`error\` doesn't bubble.
			document.addEventListener('error', function (e) { fallBackToLetterTile(e.target); }, true);
			// Images load in parallel with this script, so some may have already failed
			// by the time the listener above attaches \u2014 sweep those up.
			document.querySelectorAll('.cred-icon-img').forEach(function (img) {
				if (img.complete && img.naturalWidth === 0) fallBackToLetterTile(img);
			});

			function markConnected(id) {
				if (!id || connected[id]) return;
				connected[id] = true;
				// The single-account panel and the dialog share the same data-cred-id.
				document.querySelectorAll('.cred-row[data-cred-id="' + id + '"]').forEach(function (row) {
					row.setAttribute('data-connected', 'true');
					var sub = row.querySelector('.cred-sub');
					if (sub) {
						sub.textContent = SUBMITTER_EMAIL ? 'Connected as ' + SUBMITTER_EMAIL : 'Connected';
					}
					var btn = row.querySelector('.connect');
					if (btn) {
						// Derive the revoke URL from the authorize link (same server-built base),
						// so a just-connected row can disconnect without a reload.
						var authUrl = btn.getAttribute('data-url');
						var resolverId = row.getAttribute('data-resolver-id');
						if (authUrl && resolverId && !row.getAttribute('data-revoke-url')) {
							try {
								var u = new URL(authUrl);
								u.pathname = u.pathname.replace(/\\/authorize$/, '/revoke');
								u.search = '?resolverId=' + encodeURIComponent(resolverId);
								row.setAttribute('data-revoke-url', u.toString());
							} catch (e) {}
						}
						var wrap = document.createElement('span');
						wrap.className = 'cred-connected';
						wrap.innerHTML = CONNECTED_MENU_HTML;
						btn.replaceWith(wrap);
					}
				});
				refresh();
			}

			var pendingId = null;

			// The frame is sandboxed to an opaque origin, so its own navigations are
			// treated as cross-site and lose the form's auth cookie. It asks the shell to
			// move it instead, and the shell \u2014 on the real origin \u2014 sets \`src\`, which is a
			// same-origin navigation that keeps the cookie. Narrowed to this form's own
			// follow-up pages: the frame is author-scriptable, so this must not become a
			// way to point it at arbitrary n8n pages. Returns null when the target isn't
			// one of them.
			//
			// The flag tells the page it is rendering inside this shell, which is what
			// makes it hand its own next navigation back here instead of doing it itself.
			var FORM_WAITING_PATH = '` +
				m(
					((r =
						(r = f(o, 'formWaitingPath') || (t != null ? f(t, 'formWaitingPath') : t)) != null
							? r
							: u),
					typeof r === c
						? r.call(s, {
								name: 'formWaitingPath',
								hash: {},
								data: a,
								loc: { start: { line: 344, column: 28 }, end: { line: 344, column: 47 } },
							})
						: r),
				) +
				`';
			function resolveFrameNavigation(target) {
				if (typeof target !== 'string' || !target || !FORM_WAITING_PATH) return null;
				try {
					var here = new URL(window.location.href);
					var resolved = new URL(target, here);
					if (resolved.origin !== here.origin) return null;
					if (
						resolved.pathname !== FORM_WAITING_PATH &&
						resolved.pathname.indexOf(FORM_WAITING_PATH + '/') !== 0
					) {
						return null;
					}
					resolved.searchParams.set('n8nShellHosted', '1');
					return resolved.toString();
				} catch (e) {
					return null;
				}
			}

			// The author's own redirect target, once the form is done. Any http(s) URL is
			// allowed \u2014 this is where the author said to send the submitter, and a form
			// outside the shell goes there too \u2014 but the scheme has to be one of those two.
			// Returns null otherwise.
			function resolveExternalRedirect(target) {
				if (typeof target !== 'string' || !target) return null;
				try {
					var resolved = new URL(target, window.location.href);
					if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
					return resolved.toString();
				} catch (e) {
					return null;
				}
			}

			// Connected only on the oauth-callback success signal \u2014 never on popup close,
			// which also happens on provider-side failures.
			function onSuccessSignal() { if (pendingId) markConnected(pendingId); }
			try {
				var channel = new BroadcastChannel('oauth-callback');
				channel.addEventListener('message', function (event) {
					if (event.data === 'success') onSuccessSignal();
				});
			} catch (e) {}
			window.addEventListener('message', function (event) {
				// The sandboxed form iframe can't spoof a connect: it is only ever answered
				// with a page move inside this form, the author's own end-of-form redirect,
				// or the POST gate's rejection, which carries ids and moves rows one way only
				// \u2014 so the worst author script can do is degrade its own form's UX.
				// \`event.origin\` is the string 'null' for an opaque-origin frame and cannot be
				// checked; \`event.source\` identifies it.
				if (frame && event.source === frame.contentWindow) {
					if (event.data && event.data.type === 'n8n-form-navigate') {
						var next = resolveFrameNavigation(event.data.url);
						if (next) frame.src = next;
						return;
					}
					if (event.data && event.data.type === 'n8n-form-redirect') {
						// The form is finished, so the author's redirect takes the whole tab \u2014
						// the same place a form rendered without this shell would end up.
						var away = resolveExternalRedirect(event.data.url);
						if (away) window.location.replace(away);
						return;
					}
					handleGateRejection(event.data);
					return;
				}
				if (event.data === 'success') onSuccessSignal();
			});

			function openConnect(id, url) {
				if (!url) return;
				pendingId = id;
				// No popup-close handler: success is confirmed only by the signals above.
				window.open(url, 'n8n-credential-connect', 'width=500,height=700,menubar=no,toolbar=no');
			}

			function markDisconnected(id) {
				if (!id) return;
				delete connected[id];
				document.querySelectorAll('.cred-row[data-cred-id="' + id + '"]').forEach(function (row) {
					row.removeAttribute('data-connected');
					var sub = row.querySelector('.cred-sub');
					if (sub) {
						// The single-account row spells out why the account is needed; the
						// dialog's rows sit under copy that already says it.
						sub.textContent = row.getAttribute('data-not-connected-text') || 'Not connected';
					}
					var wrap = row.querySelector('.cred-connected');
					if (wrap) {
						var btn = document.createElement('button');
						btn.className = 'btn btn-secondary connect';
						// The one-time authorize link was consumed by the previous connect, so
						// this Connect mints a fresh one instead of reloading (a reload would
						// re-run the form's OAuth2 auth and re-show consent).
						var revokeUrl = row.getAttribute('data-revoke-url');
						if (revokeUrl) {
							btn.setAttribute('data-authorize-url', revokeUrl.replace('/revoke?', '/authorize?'));
						}
						btn.textContent = 'Connect';
						wrap.replaceWith(btn);
					}
				});
				refresh();
			}

			// Session-cookie auth + the browser-id the session was issued with (stored in
			// localStorage on this same origin by the editor/consent pages).
			function authHeaders() {
				try {
					var browserId = localStorage.getItem('n8n-browserId');
					if (browserId) return { 'browser-id': browserId };
				} catch (e) {}
				return {};
			}

			function disconnectCred(row) {
				if (!row) return;
				var id = row.getAttribute('data-cred-id');
				var revokeUrl = row.getAttribute('data-revoke-url');
				if (!id || !revokeUrl) return;
				fetch(revokeUrl + '&authSource=cookie', {
					method: 'DELETE',
					credentials: 'include',
					headers: authHeaders(),
				})
					.then(function (r) { if (r.ok) markDisconnected(id); })
					.catch(function () {});
			}

			// Reconnect after a disconnect: mint a fresh authorize link and send the popup
			// there. The popup opens synchronously so it isn't treated as a pop-under.
			function reconnect(id, mintUrl) {
				if (!id || !mintUrl) return;
				var popup = window.open('', 'n8n-credential-connect', 'width=500,height=700,menubar=no,toolbar=no');
				pendingId = id;
				fetch(mintUrl + '&authSource=cookie', {
					method: 'POST',
					credentials: 'include',
					headers: authHeaders(),
				})
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (body) {
						var url = body && (body.data || body);
						if (typeof url === 'string' && popup) popup.location = url;
						else if (popup) popup.close();
					})
					.catch(function () { if (popup) popup.close(); });
			}

			// Delegated clicks so controls created after markConnected() also work.
			document.addEventListener('click', function (e) {
				var connectBtn = e.target.closest('.connect');
				if (connectBtn) {
					var row = connectBtn.closest('.cred-row');
					var id = row ? row.getAttribute('data-cred-id') : null;
					var mintUrl = connectBtn.getAttribute('data-authorize-url');
					if (mintUrl) reconnect(id, mintUrl);
					else openConnect(id, connectBtn.getAttribute('data-url'));
					return;
				}
				var menuBtn = e.target.closest('.btn-connected');
				if (menuBtn) {
					e.stopPropagation();
					var menu = menuBtn.parentElement.querySelector('.cred-menu');
					var wasOpen = menu && menu.classList.contains('open');
					document.querySelectorAll('.cred-menu.open').forEach(function (m) { m.classList.remove('open'); });
					if (menu && !wasOpen) {
						menu.classList.add('open');
						// Anchor to the button; flip above when out of room below.
						var r = menuBtn.getBoundingClientRect();
						var flipUp = window.innerHeight - r.bottom < menu.offsetHeight + 12;
						menu.style.top = (flipUp ? r.top - menu.offsetHeight - 4 : r.bottom + 4) + 'px';
						menu.style.left = r.right - menu.offsetWidth + 'px';
					}
					return;
				}
				var disconnectBtn = e.target.closest('.btn-disconnect');
				if (disconnectBtn) {
					e.stopPropagation();
					disconnectCred(disconnectBtn.closest('.cred-row'));
					return;
				}
				// Click elsewhere closes any open menu.
				document.querySelectorAll('.cred-menu.open').forEach(function (m) { m.classList.remove('open'); });
			});

			// Tap fallback for the info tooltip: hover/focus don't fire on touch
			// (iOS Safari doesn't focus buttons on tap), so the button toggles it.
			var summaryInfo = document.getElementById('summary-info');
			if (summaryInfo) {
				summaryInfo.querySelector('.summary-icon').addEventListener('click', function () {
					summaryInfo.classList.toggle('open');
				});
				document.addEventListener('click', function (e) {
					if (!summaryInfo.contains(e.target)) summaryInfo.classList.remove('open');
				});
			}

			// Dialog (two or more accounts)
			var overlay = document.getElementById('overlay');
			var open = document.getElementById('open-dialog');
			if (open && overlay) {
				open.addEventListener('click', function () { overlay.classList.add('open'); });
				document.getElementById('close-dialog').addEventListener('click', function () { overlay.classList.remove('open'); });
				document.getElementById('done-dialog').addEventListener('click', function () { overlay.classList.remove('open'); });
				overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.classList.remove('open'); });
			}

			// The form's POST was refused by the server-side gate. Rows rendered at page load
			// can be stale (revoked since, or disconnected in another tab), so flip the ones
			// the server no longer considers connected and surface the panel \u2014 the 2+ layout
			// otherwise keeps every row behind the summary line. Declared after the dialog
			// wiring so \`overlay\` is assigned; hoisting keeps it callable from the listener
			// above.
			function handleGateRejection(data) {
				if (!data || data.type !== 'n8n-form-credentials-rejected' || !Array.isArray(data.ids)) return;
				data.ids.forEach(function (id) {
					// Only rows the server actually rendered, so a crafted key can't walk the
					// prototype chain. Never markConnected from here \u2014 one direction only.
					if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(ids, id)) markDisconnected(id);
				});
				if (overlay) overlay.classList.add('open');
			}
		})();
	</script>
</body>

</html>
`
			);
		},
		main_d: function (n, t, o, d, a, e, l) {
			var i = o.decorators,
				r =
					o.lookupProperty ||
					function (u, c) {
						if (Object.prototype.hasOwnProperty.call(u, c)) return u[c];
					},
				s = r(i, 'inline');
			if (typeof s != 'function') throw new Error('Missing decorator: "inline"');
			return (
				(n =
					s(n, t, o, {
						name: 'inline',
						hash: {},
						fn: o.program(0, a, 0, e, l),
						inverse: o.noop,
						args: ['credRow'],
						data: a,
						loc: { start: { line: 148, column: 1 }, end: { line: 176, column: 12 } },
					}) || n),
				n
			);
		},
		useDecorators: !0,
		usePartial: !0,
		useData: !0,
		useDepths: !0,
	}),
	'form-trigger-404': b.default.template({
		0: function (n, t, o, d, a) {
			return `    <title>Form Trigger isn't listening yet</title>
`;
		},
		1: function (n, t, o, d, a) {
			return `    <title>Problem loading form</title>
`;
		},
		2: function (n, t, o, d, a) {
			var e,
				l,
				i =
					n.lookupProperty ||
					function (r, s) {
						if (Object.prototype.hasOwnProperty.call(r, s)) return r[s];
					};
			return (
				`		<style>
			` +
				((e =
					((l =
						(l = i(o, 'dangerousCustomCss') || (t != null ? i(t, 'dangerousCustomCss') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(t ?? (n.nullContext || {}), {
								name: 'dangerousCustomCss',
								hash: {},
								data: a,
								loc: { start: { line: 104, column: 3 }, end: { line: 104, column: 29 } },
							})
						: l)) != null
					? e
					: '') +
				`
		</style>
`
			);
		},
		3: function (n, t, o, d, a) {
			return `          <div class='header'>
            <h1>Form Trigger isn't listening yet</h1>
            <p>Click the <strong>"Execute step"</strong> button in your form trigger</p>
          </div>
`;
		},
		4: function (n, t, o, d, a) {
			return `          <div class='header'>
            <h1>Problem loading form</h1>
            <p>This usually occurs if the n8n workflow serving this form is deactivated or no longer exist</p>
          </div>
`;
		},
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i =
					n.lookupProperty ||
					function (r, s) {
						if (Object.prototype.hasOwnProperty.call(r, s)) return r[s];
					};
			return (
				`<!DOCTYPE html>
<html lang='en'>

<head>
  <meta charset='UTF-8' />
  <meta name='viewport' content='width=device-width, initial-scale=1.0' />
  <link rel='icon' type='image/png' href='https://n8n.io/favicon.ico' />
  <link href='https://fonts.googleapis.com/css?family=Open+Sans' rel='stylesheet' type='text/css' />
` +
				((e = i(o, 'if').call(l, t != null ? i(t, 'isTestWebhook') : t, {
					name: 'if',
					hash: {},
					fn: n.program(0, a, 0),
					inverse: n.program(1, a, 0),
					data: a,
					loc: { start: { line: 9, column: 2 }, end: { line: 13, column: 9 } },
				})) != null
					? e
					: '') +
				`  <style>
    :root {
      /* Fonts */
      --font-family: 'Open Sans', sans-serif;
      --font-weight-normal: 400;
      --font-weight-bold: 600;
      --font-size-body: 12px;
      --font-size-link: 12px;
      --font-size-header: 20px;
      --font-size-subheader: 14px;

      /* Colors */
      --color-background: #FBFCFE;
      --color-card-bg: white;
      --color-card-border: #DBDFE7;
      --color-card-shadow: #634DFF0F;
      --color-link: #7E8186;
      --color-header: #525356;
      --color-header-subtext: #7E8186;

      /* Spacing & dimensions */
      --padding-container-top: 24px;
      --container-width: 448px;
      --card-padding: 24px;
      --card-border-radius: 8px;
      --card-margin-bottom: 16px;
    }

    *,
    ::after,
    ::before {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-family);
      font-weight: var(--font-weight-normal);
      font-size: var(--font-size-body);
      display: flex;
      flex-direction: column;
      justify-content: start;
      background-color: var(--color-background);
    }

    .container {
      margin: auto;
      text-align: center;
      padding-top: var(--padding-container-top);
      width: var(--container-width);
    }

    .card {
      padding: var(--card-padding);
      background-color: var(--color-card-bg);
      border: 1px solid var(--color-card-border);
      border-radius: var(--card-border-radius);
      box-shadow: 0px 4px 16px 0px var(--color-card-shadow);
      margin-bottom: var(--card-margin-bottom);
    }

    .n8n-link a {
      color: var(--color-link);
      font-weight: var(--font-weight-bold);
      font-size: var(--font-size-link);
      text-decoration: none;
    }

    .n8n-link svg {
      display: inline-block;
      vertical-align: middle;
    }

    .header h1 {
      color: var(--color-header);
      font-size: var(--font-size-header);
      font-weight: var(--font-weight-normal);
      padding-bottom: 8px;
    }

    .header p {
      color: var(--color-header-subtext);
      font-size: var(--font-size-subheader);
      font-weight: var(--font-weight-normal);
    }
  </style>

` +
				((e = i(o, 'if').call(l, t != null ? i(t, 'dangerousCustomCss') : t, {
					name: 'if',
					hash: {},
					fn: n.program(2, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 102, column: 1 }, end: { line: 106, column: 8 } },
				})) != null
					? e
					: '') +
				`</head>

<body>
  <div class='container'>
    <section>
      <div class='card'>
` +
				((e = i(o, 'if').call(l, t != null ? i(t, 'isTestWebhook') : t, {
					name: 'if',
					hash: {},
					fn: n.program(3, a, 0),
					inverse: n.program(4, a, 0),
					data: a,
					loc: { start: { line: 113, column: 8 }, end: { line: 123, column: 15 } },
				})) != null
					? e
					: '') +
				`      </div>
      <div class='n8n-link'>
        <a href='https://n8n.io/?utm_source=n8n-internal&amp;utm_medium=form-trigger&amp' target='_blank'>
          Form automated with
          <svg width='73' height='20' viewBox='0 0 73 20' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path fill-rule='evenodd' clip-rule='evenodd'
              d='M40.2373 4C40.2373 6.20915 38.4464 8 36.2373 8C34.3735 8 32.8074 6.72525 32.3633 5H26.7787C25.801 5 24.9666 5.70685 24.8059 6.6712L24.6415 7.6576C24.4854 8.59415 24.0116 9.40925 23.3417 10C24.0116 10.5907 24.4854 11.4058 24.6415 12.3424L24.8059 13.3288C24.9666 14.2931 25.801 15 26.7787 15H28.3633C28.8074 13.2747 30.3735 12 32.2373 12C34.4464 12 36.2373 13.7908 36.2373 16C36.2373 18.2092 34.4464 20 32.2373 20C30.3735 20 28.8074 18.7253 28.3633 17H26.7787C24.8233 17 23.1546 15.5864 22.8331 13.6576L22.6687 12.6712C22.508 11.7069 21.6736 11 20.6959 11H19.0645C18.5652 12.64 17.0406 13.8334 15.2373 13.8334C13.434 13.8334 11.9094 12.64 11.4101 11H9.06449C8.56519 12.64 7.04059 13.8334 5.2373 13.8334C3.02817 13.8334 1.2373 12.0424 1.2373 9.83335C1.2373 7.6242 3.02817 5.83335 5.2373 5.83335C7.16069 5.83335 8.76699 7.19085 9.15039 9H11.3242C11.7076 7.19085 13.3139 5.83335 15.2373 5.83335C17.1607 5.83335 18.767 7.19085 19.1504 9H20.6959C21.6736 9 22.508 8.29315 22.6687 7.3288L22.8331 6.3424C23.1546 4.41365 24.8233 3 26.7787 3H32.3633C32.8074 1.27478 34.3735 0 36.2373 0C38.4464 0 40.2373 1.79086 40.2373 4ZM38.2373 4C38.2373 5.10455 37.3419 6 36.2373 6C35.1327 6 34.2373 5.10455 34.2373 4C34.2373 2.89543 35.1327 2 36.2373 2C37.3419 2 38.2373 2.89543 38.2373 4ZM5.2373 11.8334C6.34189 11.8334 7.23729 10.9379 7.23729 9.83335C7.23729 8.72875 6.34189 7.83335 5.2373 7.83335C4.13273 7.83335 3.2373 8.72875 3.2373 9.83335C3.2373 10.9379 4.13273 11.8334 5.2373 11.8334ZM15.2373 11.8334C16.3419 11.8334 17.2373 10.9379 17.2373 9.83335C17.2373 8.72875 16.3419 7.83335 15.2373 7.83335C14.1327 7.83335 13.2373 8.72875 13.2373 9.83335C13.2373 10.9379 14.1327 11.8334 15.2373 11.8334ZM32.2373 18C33.3419 18 34.2373 17.1045 34.2373 16C34.2373 14.8954 33.3419 14 32.2373 14C31.1327 14 30.2373 14.8954 30.2373 16C30.2373 17.1045 31.1327 18 32.2373 18Z'
              fill='#EA4B71'></path>
            <path
              d='M44.2393 15.0007H46.3277V10.5791C46.3277 9.12704 47.2088 8.49074 48.204 8.49074C49.183 8.49074 49.9498 9.14334 49.9498 10.4812V15.0007H52.038V10.057C52.038 7.91969 50.798 6.67969 48.8567 6.67969C47.633 6.67969 46.9477 7.16914 46.4582 7.80544H46.3277L46.1482 6.84284H44.2393V15.0007Z'
              fill='#101330'></path>
            <path
              d='M60.0318 9.50205V9.40415C60.7498 9.0452 61.4678 8.4252 61.4678 7.20155C61.4678 5.43945 60.0153 4.37891 58.0088 4.37891C55.9528 4.37891 54.4843 5.5047 54.4843 7.23415C54.4843 8.4089 55.1698 9.0452 55.9203 9.40415V9.50205C55.0883 9.79575 54.0928 10.6768 54.0928 12.1452C54.0928 13.9237 55.5613 15.1637 57.9923 15.1637C60.4233 15.1637 61.8428 13.9237 61.8428 12.1452C61.8428 10.6768 60.8638 9.81205 60.0318 9.50205ZM57.9923 5.87995C58.8083 5.87995 59.4118 6.40205 59.4118 7.2831C59.4118 8.16415 58.7918 8.6863 57.9923 8.6863C57.1928 8.6863 56.5238 8.16415 56.5238 7.2831C56.5238 6.38575 57.1603 5.87995 57.9923 5.87995ZM57.9923 13.5974C57.0458 13.5974 56.2793 12.9937 56.2793 11.9658C56.2793 11.0358 56.9153 10.3342 57.9758 10.3342C59.0203 10.3342 59.6568 11.0195 59.6568 11.9984C59.6568 12.9937 58.9223 13.5974 57.9923 13.5974Z'
              fill='#101330'></path>
            <path
              d='M63.9639 15.0007H66.0524V10.5791C66.0524 9.12704 66.9334 8.49074 67.9289 8.49074C68.9079 8.49074 69.6744 9.14334 69.6744 10.4812V15.0007H71.7629V10.057C71.7629 7.91969 70.5229 6.67969 68.5814 6.67969C67.3579 6.67969 66.6724 7.16914 66.1829 7.80544H66.0524L65.8729 6.84284H63.9639V15.0007Z'
              fill='#101330'></path>
          </svg>
        </a>
      </div>
    </section>
  </div>
</body>

</html>
`
			);
		},
		useData: !0,
	}),
	'form-trigger-409': b.default.template({
		0: function (n, t, o, d, a) {
			var e,
				l,
				i =
					n.lookupProperty ||
					function (r, s) {
						if (Object.prototype.hasOwnProperty.call(r, s)) return r[s];
					};
			return (
				`		<style>
			` +
				((e =
					((l =
						(l = i(o, 'dangerousCustomCss') || (t != null ? i(t, 'dangerousCustomCss') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(t ?? (n.nullContext || {}), {
								name: 'dangerousCustomCss',
								hash: {},
								data: a,
								loc: { start: { line: 100, column: 3 }, end: { line: 100, column: 29 } },
							})
						: l)) != null
					? e
					: '') +
				`
		</style>
`
			);
		},
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r =
					n.lookupProperty ||
					function (s, u) {
						if (Object.prototype.hasOwnProperty.call(s, u)) return s[u];
					};
			return (
				`<!DOCTYPE html>
<html lang='en'>

<head>
	<meta charset='UTF-8' />
	<meta name='viewport' content='width=device-width, initial-scale=1.0' />
	<link rel='icon' type='image/png' href='https://n8n.io/favicon.ico' />
	<link href='https://fonts.googleapis.com/css?family=Open+Sans' rel='stylesheet' type='text/css' />
	<title>Problem loading form</title>
	<style>
		:root {
			/* Fonts */
			--font-family: 'Open Sans', sans-serif;
			--font-weight-normal: 400;
			--font-weight-bold: 600;
			--font-size-body: 12px;
			--font-size-link: 12px;
			--font-size-header: 20px;
			--font-size-subheader: 14px;

			/* Colors */
			--color-background: #FBFCFE;
			--color-card-bg: white;
			--color-card-border: #DBDFE7;
			--color-card-shadow: #634DFF0F;
			--color-link: #7E8186;
			--color-header: #525356;
			--color-header-subtext: #7E8186;

			/* Spacing and dimensions */
			--padding-container-top: 24px;
			--container-width: 448px;
			--card-padding: 24px;
			--card-border-radius: 8px;
			--card-margin-bottom: 16px;
		}

		*,
		::after,
		::before {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: var(--font-family);
			font-weight: var(--font-weight-normal);
			font-size: var(--font-size-body);
			display: flex;
			flex-direction: column;
			justify-content: start;
			background-color: var(--color-background);
		}

		.container {
			margin: auto;
			text-align: center;
			padding-top: var(--padding-container-top);
			width: var(--container-width);
		}

		.card {
			padding: var(--card-padding);
			background-color: var(--color-card-bg);
			border: 1px solid var(--color-card-border);
			border-radius: var(--card-border-radius);
			box-shadow: 0px 4px 16px 0px var(--color-card-shadow);
			margin-bottom: var(--card-margin-bottom);
		}

		.n8n-link a {
			color: var(--color-link);
			font-weight: var(--font-weight-bold);
			font-size: var(--font-size-link);
			text-decoration: none;
		}

		.n8n-link svg {
			display: inline-block;
			vertical-align: middle;
		}

		.header h1 {
			color: var(--color-header);
			font-size: var(--font-size-header);
			font-weight: var(--font-weight-normal);
			padding-bottom: 8px;
		}

		.header p {
			color: var(--color-header-subtext);
			font-size: var(--font-size-subheader);
			font-weight: var(--font-weight-normal);
		}
	</style>

` +
				((e = r(o, 'if').call(i, t != null ? r(t, 'dangerousCustomCss') : t, {
					name: 'if',
					hash: {},
					fn: n.program(0, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 98, column: 1 }, end: { line: 102, column: 8 } },
				})) != null
					? e
					: '') +
				`</head>

<body>
	<div class='container'>
		<section>
			<div class='card'>
				<div class='header'>
					<h1>Problem loading form</h1>
					<p>` +
				n.escapeExpression(
					((l =
						(l = r(o, 'message') || (t != null ? r(t, 'message') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(i, {
								name: 'message',
								hash: {},
								data: a,
								loc: { start: { line: 111, column: 8 }, end: { line: 111, column: 19 } },
							})
						: l),
				) +
				`</p>
				</div>
			</div>
			<div class='n8n-link'>
				<a href='https://n8n.io/?utm_source=n8n-internal&amp;utm_medium=form-trigger&amp' target='_blank'>
					Form automated with
					<svg width='73' height='20' viewBox='0 0 73 20' fill='none' xmlns='http://www.w3.org/2000/svg'>
						<path fill-rule='evenodd' clip-rule='evenodd'
							d='M40.2373 4C40.2373 6.20915 38.4464 8 36.2373 8C34.3735 8 32.8074 6.72525 32.3633 5H26.7787C25.801 5 24.9666 5.70685 24.8059 6.6712L24.6415 7.6576C24.4854 8.59415 24.0116 9.40925 23.3417 10C24.0116 10.5907 24.4854 11.4058 24.6415 12.3424L24.8059 13.3288C24.9666 14.2931 25.801 15 26.7787 15H28.3633C28.8074 13.2747 30.3735 12 32.2373 12C34.4464 12 36.2373 13.7908 36.2373 16C36.2373 18.2092 34.4464 20 32.2373 20C30.3735 20 28.8074 18.7253 28.3633 17H26.7787C24.8233 17 23.1546 15.5864 22.8331 13.6576L22.6687 12.6712C22.508 11.7069 21.6736 11 20.6959 11H19.0645C18.5652 12.64 17.0406 13.8334 15.2373 13.8334C13.434 13.8334 11.9094 12.64 11.4101 11H9.06449C8.56519 12.64 7.04059 13.8334 5.2373 13.8334C3.02817 13.8334 1.2373 12.0424 1.2373 9.83335C1.2373 7.6242 3.02817 5.83335 5.2373 5.83335C7.16069 5.83335 8.76699 7.19085 9.15039 9H11.3242C11.7076 7.19085 13.3139 5.83335 15.2373 5.83335C17.1607 5.83335 18.767 7.19085 19.1504 9H20.6959C21.6736 9 22.508 8.29315 22.6687 7.3288L22.8331 6.3424C23.1546 4.41365 24.8233 3 26.7787 3H32.3633C32.8074 1.27478 34.3735 0 36.2373 0C38.4464 0 40.2373 1.79086 40.2373 4ZM38.2373 4C38.2373 5.10455 37.3419 6 36.2373 6C35.1327 6 34.2373 5.10455 34.2373 4C34.2373 2.89543 35.1327 2 36.2373 2C37.3419 2 38.2373 2.89543 38.2373 4ZM5.2373 11.8334C6.34189 11.8334 7.23729 10.9379 7.23729 9.83335C7.23729 8.72875 6.34189 7.83335 5.2373 7.83335C4.13273 7.83335 3.2373 8.72875 3.2373 9.83335C3.2373 10.9379 4.13273 11.8334 5.2373 11.8334ZM15.2373 11.8334C16.3419 11.8334 17.2373 10.9379 17.2373 9.83335C17.2373 8.72875 16.3419 7.83335 15.2373 7.83335C14.1327 7.83335 13.2373 8.72875 13.2373 9.83335C13.2373 10.9379 14.1327 11.8334 15.2373 11.8334ZM32.2373 18C33.3419 18 34.2373 17.1045 34.2373 16C34.2373 14.8954 33.3419 14 32.2373 14C31.1327 14 30.2373 14.8954 30.2373 16C30.2373 17.1045 31.1327 18 32.2373 18Z'
							fill='#EA4B71'></path>
						<path
							d='M44.2393 15.0007H46.3277V10.5791C46.3277 9.12704 47.2088 8.49074 48.204 8.49074C49.183 8.49074 49.9498 9.14334 49.9498 10.4812V15.0007H52.038V10.057C52.038 7.91969 50.798 6.67969 48.8567 6.67969C47.633 6.67969 46.9477 7.16914 46.4582 7.80544H46.3277L46.1482 6.84284H44.2393V15.0007Z'
							fill='#101330'></path>
						<path
							d='M60.0318 9.50205V9.40415C60.7498 9.0452 61.4678 8.4252 61.4678 7.20155C61.4678 5.43945 60.0153 4.37891 58.0088 4.37891C55.9528 4.37891 54.4843 5.5047 54.4843 7.23415C54.4843 8.4089 55.1698 9.0452 55.9203 9.40415V9.50205C55.0883 9.79575 54.0928 10.6768 54.0928 12.1452C54.0928 13.9237 55.5613 15.1637 57.9923 15.1637C60.4233 15.1637 61.8428 13.9237 61.8428 12.1452C61.8428 10.6768 60.8638 9.81205 60.0318 9.50205ZM57.9923 5.87995C58.8083 5.87995 59.4118 6.40205 59.4118 7.2831C59.4118 8.16415 58.7918 8.6863 57.9923 8.6863C57.1928 8.6863 56.5238 8.16415 56.5238 7.2831C56.5238 6.38575 57.1603 5.87995 57.9923 5.87995ZM57.9923 13.5974C57.0458 13.5974 56.2793 12.9937 56.2793 11.9658C56.2793 11.0358 56.9153 10.3342 57.9758 10.3342C59.0203 10.3342 59.6568 11.0195 59.6568 11.9984C59.6568 12.9937 58.9223 13.5974 57.9923 13.5974Z'
							fill='#101330'></path>
						<path
							d='M63.9639 15.0007H66.0524V10.5791C66.0524 9.12704 66.9334 8.49074 67.9289 8.49074C68.9079 8.49074 69.6744 9.14334 69.6744 10.4812V15.0007H71.7629V10.057C71.7629 7.91969 70.5229 6.67969 68.5814 6.67969C67.3579 6.67969 66.6724 7.16914 66.1829 7.80544H66.0524L65.8729 6.84284H63.9639V15.0007Z'
							fill='#101330'></path>
					</svg>
				</a>
			</div>
		</section>
	</div>
</body>

</html>
`
			);
		},
		useData: !0,
	}),
	'form-trigger-completion': b.default.template({
		0: function (n, t, o, d, a) {
			var e,
				l,
				i =
					n.lookupProperty ||
					function (r, s) {
						if (Object.prototype.hasOwnProperty.call(r, s)) return r[s];
					};
			return (
				`		<style>
			` +
				((e =
					((l =
						(l = i(o, 'dangerousCustomCss') || (t != null ? i(t, 'dangerousCustomCss') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(t ?? (n.nullContext || {}), {
								name: 'dangerousCustomCss',
								hash: {},
								data: a,
								loc: { start: { line: 102, column: 3 }, end: { line: 102, column: 29 } },
							})
						: l)) != null
					? e
					: '') +
				`
		</style>
`
			);
		},
		1: function (n, t, o, d, a) {
			var e,
				l,
				i =
					n.lookupProperty ||
					function (r, s) {
						if (Object.prototype.hasOwnProperty.call(r, s)) return r[s];
					};
			return (
				'			' +
				((e =
					((l =
						(l = i(o, 'responseText') || (t != null ? i(t, 'responseText') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(t ?? (n.nullContext || {}), {
								name: 'responseText',
								hash: {},
								data: a,
								loc: { start: { line: 109, column: 3 }, end: { line: 109, column: 21 } },
							})
						: l)) != null
					? e
					: '') +
				`
`
			);
		},
		2: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (e = l(o, 'if').call(t ?? (n.nullContext || {}), t != null ? l(t, 'redirectUrl') : t, {
				name: 'if',
				hash: {},
				fn: n.program(3, a, 0),
				inverse: n.program(4, a, 0),
				data: a,
				loc: { start: { line: 110, column: 2 }, end: { line: 156, column: 2 } },
			})) != null
				? e
				: '';
		},
		3: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				"			<div>Redirecting to <a href='" +
				s(
					((e = (e = u(o, 'redirectUrl') || (t != null ? u(t, 'redirectUrl') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'redirectUrl',
								hash: {},
								data: a,
								loc: { start: { line: 111, column: 32 }, end: { line: 111, column: 47 } },
							})
						: e),
				) +
				"'>" +
				s(
					((e = (e = u(o, 'redirectUrl') || (t != null ? u(t, 'redirectUrl') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'redirectUrl',
								hash: {},
								data: a,
								loc: { start: { line: 111, column: 49 }, end: { line: 111, column: 64 } },
							})
						: e),
				) +
				`</a></div>
`
			);
		},
		4: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r = n.hooks.helperMissing,
				s = 'function',
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				`			<div class='container'>
				<section>
					<div class='card'>
						<div class='header'>
							<h1>` +
				n.escapeExpression(
					((l = (l = u(o, 'title') || (t != null ? u(t, 'title') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'title',
								hash: {},
								data: a,
								loc: { start: { line: 117, column: 11 }, end: { line: 117, column: 20 } },
							})
						: l),
				) +
				`</h1>
							<p style="white-space: pre-line;">` +
				((e =
					((l = (l = u(o, 'message') || (t != null ? u(t, 'message') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'message',
								hash: {},
								data: a,
								loc: { start: { line: 118, column: 41 }, end: { line: 118, column: 54 } },
							})
						: l)) != null
					? e
					: '') +
				`</p>
						</div>
					</div>
` +
				((e = u(o, 'if').call(i, t != null ? u(t, 'appendAttribution') : t, {
					name: 'if',
					hash: {},
					fn: n.program(5, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 121, column: 5 }, end: { line: 153, column: 12 } },
				})) != null
					? e
					: '') +
				`				</section>
			</div>
		`
			);
		},
		5: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				`						<div class='n8n-link'>
							<a href='` +
				n.escapeExpression(
					((e =
						(e = l(o, 'n8nWebsiteLink') || (t != null ? l(t, 'n8nWebsiteLink') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'n8nWebsiteLink',
								hash: {},
								data: a,
								loc: { start: { line: 123, column: 16 }, end: { line: 123, column: 34 } },
							})
						: e),
				) +
				`' target='_blank'>
								Form automated with
								<svg
									width='73'
									height='20'
									viewBox='0 0 73 20'
									fill='none'
									xmlns='http://www.w3.org/2000/svg'
								>
									<path
										fill-rule='evenodd'
										clip-rule='evenodd'
										d='M40.2373 4C40.2373 6.20915 38.4464 8 36.2373 8C34.3735 8 32.8074 6.72525 32.3633 5H26.7787C25.801 5 24.9666 5.70685 24.8059 6.6712L24.6415 7.6576C24.4854 8.59415 24.0116 9.40925 23.3417 10C24.0116 10.5907 24.4854 11.4058 24.6415 12.3424L24.8059 13.3288C24.9666 14.2931 25.801 15 26.7787 15H28.3633C28.8074 13.2747 30.3735 12 32.2373 12C34.4464 12 36.2373 13.7908 36.2373 16C36.2373 18.2092 34.4464 20 32.2373 20C30.3735 20 28.8074 18.7253 28.3633 17H26.7787C24.8233 17 23.1546 15.5864 22.8331 13.6576L22.6687 12.6712C22.508 11.7069 21.6736 11 20.6959 11H19.0645C18.5652 12.64 17.0406 13.8334 15.2373 13.8334C13.434 13.8334 11.9094 12.64 11.4101 11H9.06449C8.56519 12.64 7.04059 13.8334 5.2373 13.8334C3.02817 13.8334 1.2373 12.0424 1.2373 9.83335C1.2373 7.6242 3.02817 5.83335 5.2373 5.83335C7.16069 5.83335 8.76699 7.19085 9.15039 9H11.3242C11.7076 7.19085 13.3139 5.83335 15.2373 5.83335C17.1607 5.83335 18.767 7.19085 19.1504 9H20.6959C21.6736 9 22.508 8.29315 22.6687 7.3288L22.8331 6.3424C23.1546 4.41365 24.8233 3 26.7787 3H32.3633C32.8074 1.27478 34.3735 0 36.2373 0C38.4464 0 40.2373 1.79086 40.2373 4ZM38.2373 4C38.2373 5.10455 37.3419 6 36.2373 6C35.1327 6 34.2373 5.10455 34.2373 4C34.2373 2.89543 35.1327 2 36.2373 2C37.3419 2 38.2373 2.89543 38.2373 4ZM5.2373 11.8334C6.34189 11.8334 7.23729 10.9379 7.23729 9.83335C7.23729 8.72875 6.34189 7.83335 5.2373 7.83335C4.13273 7.83335 3.2373 8.72875 3.2373 9.83335C3.2373 10.9379 4.13273 11.8334 5.2373 11.8334ZM15.2373 11.8334C16.3419 11.8334 17.2373 10.9379 17.2373 9.83335C17.2373 8.72875 16.3419 7.83335 15.2373 7.83335C14.1327 7.83335 13.2373 8.72875 13.2373 9.83335C13.2373 10.9379 14.1327 11.8334 15.2373 11.8334ZM32.2373 18C33.3419 18 34.2373 17.1045 34.2373 16C34.2373 14.8954 33.3419 14 32.2373 14C31.1327 14 30.2373 14.8954 30.2373 16C30.2373 17.1045 31.1327 18 32.2373 18Z'
										fill='#EA4B71'
									/>
									<path
										d='M44.2393 15.0007H46.3277V10.5791C46.3277 9.12704 47.2088 8.49074 48.204 8.49074C49.183 8.49074 49.9498 9.14334 49.9498 10.4812V15.0007H52.038V10.057C52.038 7.91969 50.798 6.67969 48.8567 6.67969C47.633 6.67969 46.9477 7.16914 46.4582 7.80544H46.3277L46.1482 6.84284H44.2393V15.0007Z'
										fill='#101330'
									/>
									<path
										d='M60.0318 9.50205V9.40415C60.7498 9.0452 61.4678 8.4252 61.4678 7.20155C61.4678 5.43945 60.0153 4.37891 58.0088 4.37891C55.9528 4.37891 54.4843 5.5047 54.4843 7.23415C54.4843 8.4089 55.1698 9.0452 55.9203 9.40415V9.50205C55.0883 9.79575 54.0928 10.6768 54.0928 12.1452C54.0928 13.9237 55.5613 15.1637 57.9923 15.1637C60.4233 15.1637 61.8428 13.9237 61.8428 12.1452C61.8428 10.6768 60.8638 9.81205 60.0318 9.50205ZM57.9923 5.87995C58.8083 5.87995 59.4118 6.40205 59.4118 7.2831C59.4118 8.16415 58.7918 8.6863 57.9923 8.6863C57.1928 8.6863 56.5238 8.16415 56.5238 7.2831C56.5238 6.38575 57.1603 5.87995 57.9923 5.87995ZM57.9923 13.5974C57.0458 13.5974 56.2793 12.9937 56.2793 11.9658C56.2793 11.0358 56.9153 10.3342 57.9758 10.3342C59.0203 10.3342 59.6568 11.0195 59.6568 11.9984C59.6568 12.9937 58.9223 13.5974 57.9923 13.5974Z'
										fill='#101330'
									/>
									<path
										d='M63.9639 15.0007H66.0524V10.5791C66.0524 9.12704 66.9334 8.49074 67.9289 8.49074C68.9079 8.49074 69.6744 9.14334 69.6744 10.4812V15.0007H71.7629V10.057C71.7629 7.91969 70.5229 6.67969 68.5814 6.67969C67.3579 6.67969 66.6724 7.16914 66.1829 7.80544H66.0524L65.8729 6.84284H63.9639V15.0007Z'
										fill='#101330'
									/>
								</svg>
							</a>
						</div>
`
			);
		},
		6: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"			<a id='redirectUrl' href='" +
				n.escapeExpression(
					((e =
						(e = l(o, 'redirectUrl') || (t != null ? l(t, 'redirectUrl') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'redirectUrl',
								hash: {},
								data: a,
								loc: { start: { line: 158, column: 29 }, end: { line: 158, column: 44 } },
							})
						: e),
				) +
				`' style='display: none;'></a>
`
			);
		},
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r = n.hooks.helperMissing,
				s = 'function',
				u = n.escapeExpression,
				c =
					n.lookupProperty ||
					function (m, f) {
						if (Object.prototype.hasOwnProperty.call(m, f)) return m[f];
					};
			return (
				`<!DOCTYPE html>
<html lang='en'>

<head>
	<meta charset='UTF-8' />
	<meta name='viewport' content='width=device-width, initial-scale=1.0' />
	<link rel='icon' type='image/png' href='https://n8n.io/favicon.ico' />
	<link href='https://fonts.googleapis.com/css?family=Open+Sans' rel='stylesheet' type='text/css' />

	<title>` +
				u(
					((l = (l = c(o, 'formTitle') || (t != null ? c(t, 'formTitle') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'formTitle',
								hash: {},
								data: a,
								loc: { start: { line: 10, column: 8 }, end: { line: 10, column: 21 } },
							})
						: l),
				) +
				`</title>

	<style>
		:root {
			/* Fonts */
			--font-family: 'Open Sans', sans-serif;
			--font-weight-normal: 400;
			--font-weight-bold: 600;
			--font-size-body: 12px;
			--font-size-link: 12px;
			--font-size-header: 20px;
			--font-size-subheader: 14px;

			/* Colors */
			--color-background: #FBFCFE;
			--color-card-bg: white;
			--color-card-border: #DBDFE7;
			--color-card-shadow: #634DFF0F;
			--color-link: #7E8186;
			--color-header: #525356;
			--color-header-subtext: #7E8186;

			/* Spacing and dimensions */
			--padding-container-top: 24px;
			--container-width: 448px;
			--card-padding: 24px;
			--card-margin-bottom: 16px;
			--card-border-radius: 8px;
		}

		*,
		::after,
		::before {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: var(--font-family);
			font-weight: var(--font-weight-normal);
			font-size: var(--font-size-body);
			display: flex;
			flex-direction: column;
			justify-content: start;
			background-color: var(--color-background);
		}

		.container {
			margin: auto;
			text-align: center;
			padding-top: var(--padding-container-top);
			width: var(--container-width);
		}

		.card {
			padding: var(--card-padding);
			background-color: var(--color-card-bg);
			border: 1px solid var(--color-card-border);
			border-radius: var(--card-border-radius);
			box-shadow: 0px 4px 16px 0px var(--color-card-shadow);
			margin-bottom: var(--card-margin-bottom);
		}

		.n8n-link a {
			color: var(--color-link);
			font-weight: var(--font-weight-bold);
			font-size: var(--font-size-link);
			text-decoration: none;
		}

		.n8n-link svg {
			display: inline-block;
			vertical-align: middle;
		}

		.header h1 {
			color: var(--color-header);
			font-size: var(--font-size-header);
			font-weight: var(--font-weight-normal);
			padding-bottom: 8px;
		}

		.header p {
			color: var(--color-header-subtext);
			font-size: var(--font-size-subheader);
			font-weight: var(--font-weight-normal);
		}
	</style>

` +
				((e = c(o, 'if').call(i, t != null ? c(t, 'dangerousCustomCss') : t, {
					name: 'if',
					hash: {},
					fn: n.program(0, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 100, column: 1 }, end: { line: 104, column: 8 } },
				})) != null
					? e
					: '') +
				`</head>

	<body>
` +
				((e = c(o, 'if').call(i, t != null ? c(t, 'responseText') : t, {
					name: 'if',
					hash: {},
					fn: n.program(1, a, 0),
					inverse: n.program(2, a, 0),
					data: a,
					loc: { start: { line: 108, column: 2 }, end: { line: 156, column: 9 } },
				})) != null
					? e
					: '') +
				((e = c(o, 'if').call(i, t != null ? c(t, 'redirectUrl') : t, {
					name: 'if',
					hash: {},
					fn: n.program(6, a, 0),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 157, column: 2 }, end: { line: 159, column: 9 } },
				})) != null
					? e
					: '') +
				`	<script>
		// Get signature from URL for fetch requests
		const url = new URL(window.location.href);
		const formSignature = url.searchParams.get('signature');

` +
				((e = n.invokePartial(c(d, 'formHostNavigation'), t, {
					name: 'formHostNavigation',
					hash: { withRedirect: !0, path: t != null ? c(t, 'hostNavigationPath') : t },
					data: a,
					indent: '		',
					helpers: o,
					partials: d,
					decorators: n.decorators,
				})) != null
					? e
					: '') +
				`
		let interval = 1000;
		let timeoutId;
		const checkExecutionStatus = async () => {
			if (!interval) return;

			try {
				const statusUrl = new URL(window.location.href);
				statusUrl.pathname = statusUrl.pathname + '/n8n-execution-status';
				// Include signature in fetch request for validation
				if (formSignature) {
					statusUrl.searchParams.set('signature', formSignature);
				}
				const response = await fetch(statusUrl.toString());
				const text = (await response.text()).trim();

				if (text === "form-waiting") {
					// Redirect with signature in URL (will be cleaned after load)
					const redirectUrl = new URL(window.location.href);
					if (formSignature) {
						redirectUrl.searchParams.set('signature', formSignature);
					}
					navigateTo(redirectUrl.toString());
					return;
				}

				if(["canceled", "crashed", "error", "success", "null" ].includes(text)) {
					interval = 0;
					clearTimeout(timeoutId);
					return;
				}

				interval = Math.round(interval * 1.1);
				timeoutId = setTimeout(checkExecutionStatus, interval);
			} catch (error) {
				console.error("Error fetching data:", error);
			}
		};

		document.addEventListener('DOMContentLoaded', function () {
			const binaries = "` +
				((e =
					((l =
						(l = c(o, 'responseBinary') || (t != null ? c(t, 'responseBinary') : t)) != null
							? l
							: r),
					typeof l === s
						? l.call(i, {
								name: 'responseBinary',
								hash: {},
								data: a,
								loc: { start: { line: 206, column: 21 }, end: { line: 206, column: 41 } },
							})
						: l)) != null
					? e
					: '') +
				`"
				?	JSON.parse(decodeURIComponent("` +
				((e =
					((l =
						(l = c(o, 'responseBinary') || (t != null ? c(t, 'responseBinary') : t)) != null
							? l
							: r),
					typeof l === s
						? l.call(i, {
								name: 'responseBinary',
								hash: {},
								data: a,
								loc: { start: { line: 207, column: 37 }, end: { line: 207, column: 57 } },
							})
						: l)) != null
					? e
					: '') +
				`"))
				: [];

			for (const binary of binaries) {
				const byteArray = binary.data.type === 'Buffer'
					? new Uint8Array(binary.data.data)
					: Uint8Array.from(binary.data, c => c.charCodeAt(0));

				const blob = new Blob(
					[byteArray],
					{ type: binary.type }
				);

				const link = document.createElement("a");
				link.href = URL.createObjectURL(blob);
				link.download = binary.fileName;
				document.body.appendChild(link);

				link.click();
				document.body.removeChild(link);
			}
		});

			// Include signature in POST URL for waiting forms
			let postUrl = '';
			if (window.location.href.includes('form-waiting') && formSignature) {
				postUrl = '?signature=' + encodeURIComponent(formSignature);
			}

			// Double-stash (Handlebars-escaped) so a future change to the token
			// format can't introduce HTML/JS injection here. The current token
			// is \`<base64url>|<digits>|<hex>\` \u2014 none of those characters
			// trigger HTML escaping, so this is a no-op today.
			const authToken = '` +
				u(
					((l = (l = c(o, 'authToken') || (t != null ? c(t, 'authToken') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'authToken',
								hash: {},
								data: a,
								loc: { start: { line: 240, column: 22 }, end: { line: 240, column: 35 } },
							})
						: l),
				) +
				`';
			const headers = {};
			if (authToken) {
				headers['x-auth-token'] = authToken;
			}

			fetch(postUrl, {
					method: 'POST',
					body: {},
					headers,
			})
			.then(async function (response) {
					if (response.status === 200) {
						const redirectUrl = document.getElementById("redirectUrl");
						if (redirectUrl) {
							redirectTo(redirectUrl.href);
						}
					}

					const text = await response.text();
					let json;

					try {
							json = JSON.parse(text);
					} catch (e) {}

					if (json?.redirectURL) {
							redirectTo(json.redirectURL);
					}
			})
			.catch(function (error) {
					console.error('Error:', error);
			})
			.finally(() => {
				timeoutId = setTimeout(checkExecutionStatus, interval);
			});
	</script>
	</body>

</html>
`
			);
		},
		usePartial: !0,
		useData: !0,
	}),
	'form-trigger': b.default.template({
		0: function (n, t, o, d, a) {
			return `				/* Form-level error above Submit. Unlike .error-hidden it must not reserve
				   space while empty, or every form gets a permanent gap above Submit. */
				#submit-error {
					display: none;
					color: var(--color-error);
					text-align: left;
					font-size: var(--font-size-error);
					padding-top: 6px;
					padding-bottom: 9px;
				}

				#submit-error.error-show {
					display: block;
				}
`;
		},
		1: function (n, t, o, d, a) {
			var e,
				l,
				i =
					n.lookupProperty ||
					function (r, s) {
						if (Object.prototype.hasOwnProperty.call(r, s)) return r[s];
					};
			return (
				`			<style>
				` +
				((e =
					((l =
						(l = i(o, 'dangerousCustomCss') || (t != null ? i(t, 'dangerousCustomCss') : t)) != null
							? l
							: n.hooks.helperMissing),
					typeof l == 'function'
						? l.call(t ?? (n.nullContext || {}), {
								name: 'dangerousCustomCss',
								hash: {},
								data: a,
								loc: { start: { line: 501, column: 4 }, end: { line: 501, column: 30 } },
							})
						: l)) != null
					? e
					: '') +
				`
			</style>
`
			);
		},
		2: function (n, t, o, d, a) {
			return `					<div class='test-notice'>
						<p>This is a test version of your form</p>
					</div>
					<hr>
`;
		},
		3: function (n, t, o, d, a, e, l) {
			var i,
				r = t ?? (n.nullContext || {}),
				s =
					n.lookupProperty ||
					function (u, c) {
						if (Object.prototype.hasOwnProperty.call(u, c)) return u[c];
					};
			return (
				((i = s(o, 'if').call(r, t != null ? s(t, 'isMultiSelect') : t, {
					name: 'if',
					hash: {},
					fn: n.program(4, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 524, column: 7 }, end: { line: 566, column: 14 } },
				})) != null
					? i
					: '') +
				`
` +
				((i = s(o, 'if').call(r, t != null ? s(t, 'isSelect') : t, {
					name: 'if',
					hash: {},
					fn: n.program(14, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 568, column: 7 }, end: { line: 591, column: 14 } },
				})) != null
					? i
					: '') +
				`
` +
				((i = s(o, 'if').call(r, t != null ? s(t, 'isHtml') : t, {
					name: 'if',
					hash: {},
					fn: n.program(20, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 593, column: 7 }, end: { line: 598, column: 14 } },
				})) != null
					? i
					: '') +
				`
` +
				((i = s(o, 'if').call(r, t != null ? s(t, 'isHidden') : t, {
					name: 'if',
					hash: {},
					fn: n.program(21, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 600, column: 7 }, end: { line: 602, column: 14 } },
				})) != null
					? i
					: '') +
				`
` +
				((i = s(o, 'if').call(r, t != null ? s(t, 'isTextarea') : t, {
					name: 'if',
					hash: {},
					fn: n.program(22, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 604, column: 7 }, end: { line: 617, column: 14 } },
				})) != null
					? i
					: '') +
				`
` +
				((i = s(o, 'if').call(r, t != null ? s(t, 'isFileInput') : t, {
					name: 'if',
					hash: {},
					fn: n.program(23, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 619, column: 7 }, end: { line: 636, column: 14 } },
				})) != null
					? i
					: '') +
				`
` +
				((i = s(o, 'if').call(r, t != null ? s(t, 'isInput') : t, {
					name: 'if',
					hash: {},
					fn: n.program(24, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 638, column: 7 }, end: { line: 653, column: 14 } },
				})) != null
					? i
					: '')
			);
		},
		4: function (n, t, o, d, a, e, l) {
			var i,
				r,
				s = t ?? (n.nullContext || {}),
				u = n.hooks.helperMissing,
				c = 'function',
				m = n.escapeExpression,
				f =
					n.lookupProperty ||
					function (p, g) {
						if (Object.prototype.hasOwnProperty.call(p, g)) return p[g];
					};
			return (
				`								<div>
									<label class='form-label ` +
				m(
					((r =
						(r = f(o, 'inputRequired') || (t != null ? f(t, 'inputRequired') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 526, column: 34 }, end: { line: 526, column: 51 } },
							})
						: r),
				) +
				"'>" +
				m(
					((r = (r = f(o, 'label') || (t != null ? f(t, 'label') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 526, column: 53 }, end: { line: 526, column: 62 } },
							})
						: r),
				) +
				`</label>
									<div
									  class='multiselect ` +
				m(
					((r =
						(r = f(o, 'inputRequired') || (t != null ? f(t, 'inputRequired') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 528, column: 30 }, end: { line: 528, column: 47 } },
							})
						: r),
				) +
				`'
										id='` +
				m(
					((r = (r = f(o, 'id') || (t != null ? f(t, 'id') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 529, column: 14 }, end: { line: 529, column: 20 } },
							})
						: r),
				) +
				`'
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'radioSelect') : t, {
					name: 'if',
					hash: {},
					fn: n.program(5, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 530, column: 10 }, end: { line: 532, column: 17 } },
				})) != null
					? i
					: '') +
				((i = f(o, 'if').call(s, t != null ? f(t, 'exactSelectedOptions') : t, {
					name: 'if',
					hash: {},
					fn: n.program(6, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 533, column: 10 }, end: { line: 535, column: 17 } },
				})) != null
					? i
					: '') +
				((i = f(o, 'if').call(s, t != null ? f(t, 'minSelectedOptions') : t, {
					name: 'if',
					hash: {},
					fn: n.program(7, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 536, column: 10 }, end: { line: 538, column: 17 } },
				})) != null
					? i
					: '') +
				((i = f(o, 'if').call(s, t != null ? f(t, 'maxSelectedOptions') : t, {
					name: 'if',
					hash: {},
					fn: n.program(8, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 539, column: 10 }, end: { line: 541, column: 17 } },
				})) != null
					? i
					: '') +
				`									>
` +
				((i = f(o, 'each').call(s, t != null ? f(t, 'multiSelectOptions') : t, {
					name: 'each',
					hash: {},
					fn: n.program(9, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 543, column: 10 }, end: { line: 560, column: 19 } },
				})) != null
					? i
					: '') +
				`									</div>
									<p class='` +
				m(
					((r = (r = f(o, 'errorId') || (t != null ? f(t, 'errorId') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'errorId',
								hash: {},
								data: a,
								loc: { start: { line: 562, column: 19 }, end: { line: 562, column: 30 } },
							})
						: r),
				) +
				` error-hidden'>
										This field is required
									</p>
								</div>
`
			);
		},
		5: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"											data-radio-select='" +
				n.escapeExpression(
					((e =
						(e = l(o, 'radioSelect') || (t != null ? l(t, 'radioSelect') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'radioSelect',
								hash: {},
								data: a,
								loc: { start: { line: 531, column: 30 }, end: { line: 531, column: 45 } },
							})
						: e),
				) +
				`'
`
			);
		},
		6: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"											data-exact-select='" +
				n.escapeExpression(
					((e =
						(e = l(o, 'exactSelectedOptions') || (t != null ? l(t, 'exactSelectedOptions') : t)) !=
						null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'exactSelectedOptions',
								hash: {},
								data: a,
								loc: { start: { line: 534, column: 30 }, end: { line: 534, column: 54 } },
							})
						: e),
				) +
				`'
`
			);
		},
		7: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"											data-min-select='" +
				n.escapeExpression(
					((e =
						(e = l(o, 'minSelectedOptions') || (t != null ? l(t, 'minSelectedOptions') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'minSelectedOptions',
								hash: {},
								data: a,
								loc: { start: { line: 537, column: 28 }, end: { line: 537, column: 50 } },
							})
						: e),
				) +
				`'
`
			);
		},
		8: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"											data-max-select='" +
				n.escapeExpression(
					((e =
						(e = l(o, 'maxSelectedOptions') || (t != null ? l(t, 'maxSelectedOptions') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'maxSelectedOptions',
								hash: {},
								data: a,
								loc: { start: { line: 540, column: 28 }, end: { line: 540, column: 50 } },
							})
						: e),
				) +
				`'
`
			);
		},
		9: function (n, t, o, d, a, e, l) {
			var i,
				r,
				s = t ?? (n.nullContext || {}),
				u = n.hooks.helperMissing,
				c = 'function',
				m = n.escapeExpression,
				f =
					n.lookupProperty ||
					function (p, g) {
						if (Object.prototype.hasOwnProperty.call(p, g)) return p[g];
					};
			return (
				`											<div class='multiselect-option'>
` +
				((i = f(o, 'if').call(s, l[1] != null ? f(l[1], 'radioSelect') : l[1], {
					name: 'if',
					hash: {},
					fn: n.program(10, a, 0, e, l),
					inverse: n.program(13, a, 0, e, l),
					data: a,
					loc: { start: { line: 545, column: 12 }, end: { line: 557, column: 19 } },
				})) != null
					? i
					: '') +
				"												<label for='" +
				m(
					((r = (r = f(o, 'id') || (t != null ? f(t, 'id') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 558, column: 24 }, end: { line: 558, column: 30 } },
							})
						: r),
				) +
				"'>" +
				m(
					((r = (r = f(o, 'label') || (t != null ? f(t, 'label') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 558, column: 32 }, end: { line: 558, column: 41 } },
							})
						: r),
				) +
				`</label>
											</div>
`
			);
		},
		10: function (n, t, o, d, a, e, l) {
			var i,
				r = t ?? (n.nullContext || {}),
				s =
					n.lookupProperty ||
					function (u, c) {
						if (Object.prototype.hasOwnProperty.call(u, c)) return u[c];
					};
			return (i = s(o, 'if').call(
				r,
				(s(o, 'eq') || (t && s(t, 'eq')) || n.hooks.helperMissing).call(
					r,
					l[1] != null ? s(l[1], 'defaultValue') : l[1],
					t != null ? s(t, 'label') : t,
					{
						name: 'eq',
						hash: {},
						data: a,
						loc: { start: { line: 546, column: 19 }, end: { line: 546, column: 45 } },
					},
				),
				{
					name: 'if',
					hash: {},
					fn: n.program(11, a, 0, e, l),
					inverse: n.program(12, a, 0, e, l),
					data: a,
					loc: { start: { line: 546, column: 13 }, end: { line: 550, column: 20 } },
				},
			)) != null
				? i
				: '';
		},
		11: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				"														<input type='checkbox' class='multiselect-checkbox' id='" +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 547, column: 70 }, end: { line: 547, column: 76 } },
							})
						: e),
				) +
				"' value='" +
				s(
					((e = (e = u(o, 'label') || (t != null ? u(t, 'label') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 547, column: 85 }, end: { line: 547, column: 94 } },
							})
						: e),
				) +
				`' checked />
`
			);
		},
		12: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				"														<input type='checkbox' class='multiselect-checkbox' id='" +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 549, column: 70 }, end: { line: 549, column: 76 } },
							})
						: e),
				) +
				"' value='" +
				s(
					((e = (e = u(o, 'label') || (t != null ? u(t, 'label') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 549, column: 85 }, end: { line: 549, column: 94 } },
							})
						: e),
				) +
				`' />
`
			);
		},
		13: function (n, t, o, d, a, e, l) {
			var i,
				r = t ?? (n.nullContext || {}),
				s =
					n.lookupProperty ||
					function (u, c) {
						if (Object.prototype.hasOwnProperty.call(u, c)) return u[c];
					};
			return (i = s(o, 'if').call(
				r,
				(s(o, 'includes') || (t && s(t, 'includes')) || n.hooks.helperMissing).call(
					r,
					l[1] != null ? s(l[1], 'defaultValue') : l[1],
					t != null ? s(t, 'label') : t,
					{
						name: 'includes',
						hash: {},
						data: a,
						loc: { start: { line: 552, column: 19 }, end: { line: 552, column: 51 } },
					},
				),
				{
					name: 'if',
					hash: {},
					fn: n.program(11, a, 0, e, l),
					inverse: n.program(12, a, 0, e, l),
					data: a,
					loc: { start: { line: 552, column: 13 }, end: { line: 556, column: 20 } },
				},
			)) != null
				? i
				: '';
		},
		14: function (n, t, o, d, a, e, l) {
			var i,
				r,
				s = t ?? (n.nullContext || {}),
				u = n.hooks.helperMissing,
				c = 'function',
				m = n.escapeExpression,
				f =
					n.lookupProperty ||
					function (p, g) {
						if (Object.prototype.hasOwnProperty.call(p, g)) return p[g];
					};
			return (
				`								<div class='form-group'>
									<label class='form-label ` +
				m(
					((r =
						(r = f(o, 'inputRequired') || (t != null ? f(t, 'inputRequired') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 570, column: 34 }, end: { line: 570, column: 51 } },
							})
						: r),
				) +
				"' for='" +
				m(
					((r = (r = f(o, 'id') || (t != null ? f(t, 'id') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 570, column: 58 }, end: { line: 570, column: 64 } },
							})
						: r),
				) +
				"'>" +
				m(
					((r = (r = f(o, 'label') || (t != null ? f(t, 'label') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 570, column: 66 }, end: { line: 570, column: 75 } },
							})
						: r),
				) +
				`</label>
									<div class='select-input'>
										<select id='` +
				m(
					((r = (r = f(o, 'id') || (t != null ? f(t, 'id') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 572, column: 22 }, end: { line: 572, column: 28 } },
							})
						: r),
				) +
				"' name='" +
				m(
					((r = (r = f(o, 'id') || (t != null ? f(t, 'id') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 572, column: 36 }, end: { line: 572, column: 42 } },
							})
						: r),
				) +
				"' class='" +
				m(
					((r =
						(r = f(o, 'inputRequired') || (t != null ? f(t, 'inputRequired') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 572, column: 51 }, end: { line: 572, column: 68 } },
							})
						: r),
				) +
				`'>
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'defaultValue') : t, {
					name: 'if',
					hash: {},
					fn: n.program(15, a, 0, e, l),
					inverse: n.program(16, a, 0, e, l),
					data: a,
					loc: { start: { line: 573, column: 11 }, end: { line: 577, column: 18 } },
				})) != null
					? i
					: '') +
				((i = f(o, 'each').call(s, t != null ? f(t, 'selectOptions') : t, {
					name: 'each',
					hash: {},
					fn: n.program(17, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 578, column: 11 }, end: { line: 584, column: 20 } },
				})) != null
					? i
					: '') +
				`										</select>
									</div>
									<p class='` +
				m(
					((r = (r = f(o, 'errorId') || (t != null ? f(t, 'errorId') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'errorId',
								hash: {},
								data: a,
								loc: { start: { line: 587, column: 19 }, end: { line: 587, column: 30 } },
							})
						: r),
				) +
				` error-hidden'>
										This field is required
									</p>
								</div>
`
			);
		},
		15: function (n, t, o, d, a) {
			return `												<option value='' disabled>Select an option ...</option>
`;
		},
		16: function (n, t, o, d, a) {
			return `												<option value='' disabled selected>Select an option ...</option>
`;
		},
		17: function (n, t, o, d, a, e, l) {
			var i,
				r = t ?? (n.nullContext || {}),
				s =
					n.lookupProperty ||
					function (u, c) {
						if (Object.prototype.hasOwnProperty.call(u, c)) return u[c];
					};
			return (i = s(o, 'if').call(
				r,
				(s(o, 'eq') || (t && s(t, 'eq')) || n.hooks.helperMissing).call(
					r,
					l[1] != null ? s(l[1], 'defaultValue') : l[1],
					t,
					{
						name: 'eq',
						hash: {},
						data: a,
						loc: { start: { line: 579, column: 18 }, end: { line: 579, column: 43 } },
					},
				),
				{
					name: 'if',
					hash: {},
					fn: n.program(18, a, 0, e, l),
					inverse: n.program(19, a, 0, e, l),
					data: a,
					loc: { start: { line: 579, column: 12 }, end: { line: 583, column: 19 } },
				},
			)) != null
				? i
				: '';
		},
		18: function (n, t, o, d, a) {
			var e = n.lambda,
				l = n.escapeExpression;
			return (
				"													<option value='" +
				l(e(t, t)) +
				"' selected>" +
				l(e(t, t)) +
				`</option>
`
			);
		},
		19: function (n, t, o, d, a) {
			var e = n.lambda,
				l = n.escapeExpression;
			return (
				"													<option value='" +
				l(e(t, t)) +
				"'>" +
				l(e(t, t)) +
				`</option>
`
			);
		},
		20: function (n, t, o, d, a) {
			var e,
				l,
				i = t ?? (n.nullContext || {}),
				r = n.hooks.helperMissing,
				s = 'function',
				u = n.escapeExpression,
				c =
					n.lookupProperty ||
					function (m, f) {
						if (Object.prototype.hasOwnProperty.call(m, f)) return m[f];
					};
			return (
				`								<div class="form-group html">
									` +
				((e =
					((l = (l = c(o, 'html') || (t != null ? c(t, 'html') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'html',
								hash: {},
								data: a,
								loc: { start: { line: 595, column: 9 }, end: { line: 595, column: 19 } },
							})
						: l)) != null
					? e
					: '') +
				`
									<input type="hidden" id="` +
				u(
					((l = (l = c(o, 'id') || (t != null ? c(t, 'id') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 596, column: 34 }, end: { line: 596, column: 40 } },
							})
						: l),
				) +
				'" name="' +
				u(
					((l = (l = c(o, 'id') || (t != null ? c(t, 'id') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 596, column: 48 }, end: { line: 596, column: 54 } },
							})
						: l),
				) +
				'" value="' +
				u(
					((l = (l = c(o, 'html') || (t != null ? c(t, 'html') : t)) != null ? l : r),
					typeof l === s
						? l.call(i, {
								name: 'html',
								hash: {},
								data: a,
								loc: { start: { line: 596, column: 63 }, end: { line: 596, column: 71 } },
							})
						: l),
				) +
				`" />
								</div>
`
			);
		},
		21: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				'								<input type="hidden" id="' +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 601, column: 33 }, end: { line: 601, column: 39 } },
							})
						: e),
				) +
				'" name="' +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 601, column: 47 }, end: { line: 601, column: 53 } },
							})
						: e),
				) +
				'" value="' +
				s(
					((e = (e = u(o, 'hiddenValue') || (t != null ? u(t, 'hiddenValue') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'hiddenValue',
								hash: {},
								data: a,
								loc: { start: { line: 601, column: 62 }, end: { line: 601, column: 77 } },
							})
						: e),
				) +
				`" />
`
			);
		},
		22: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				`								<div class='form-group'>
									<label class='form-label ` +
				s(
					((e =
						(e = u(o, 'inputRequired') || (t != null ? u(t, 'inputRequired') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 606, column: 34 }, end: { line: 606, column: 51 } },
							})
						: e),
				) +
				"' for='" +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 606, column: 58 }, end: { line: 606, column: 64 } },
							})
						: e),
				) +
				"'>" +
				s(
					((e = (e = u(o, 'label') || (t != null ? u(t, 'label') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 606, column: 66 }, end: { line: 606, column: 75 } },
							})
						: e),
				) +
				`</label>
									<textarea
										class='form-input ` +
				s(
					((e =
						(e = u(o, 'inputRequired') || (t != null ? u(t, 'inputRequired') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 608, column: 28 }, end: { line: 608, column: 45 } },
							})
						: e),
				) +
				`'
										id='` +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 609, column: 14 }, end: { line: 609, column: 20 } },
							})
						: e),
				) +
				`'
										name='` +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 610, column: 16 }, end: { line: 610, column: 22 } },
							})
						: e),
				) +
				`'
										placeholder="` +
				s(
					((e = (e = u(o, 'placeholder') || (t != null ? u(t, 'placeholder') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'placeholder',
								hash: {},
								data: a,
								loc: { start: { line: 611, column: 23 }, end: { line: 611, column: 38 } },
							})
						: e),
				) +
				`"
									>` +
				s(
					((e =
						(e = u(o, 'defaultValue') || (t != null ? u(t, 'defaultValue') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'defaultValue',
								hash: {},
								data: a,
								loc: { start: { line: 612, column: 10 }, end: { line: 612, column: 26 } },
							})
						: e),
				) +
				`</textarea>
									<p class='` +
				s(
					((e = (e = u(o, 'errorId') || (t != null ? u(t, 'errorId') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'errorId',
								hash: {},
								data: a,
								loc: { start: { line: 613, column: 19 }, end: { line: 613, column: 30 } },
							})
						: e),
				) +
				` error-hidden'>
										This field is required
									</p>
								</div>
`
			);
		},
		23: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				`								<div class='form-group file-input-wrapper'>
									<label class='form-label ` +
				s(
					((e =
						(e = u(o, 'inputRequired') || (t != null ? u(t, 'inputRequired') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 621, column: 34 }, end: { line: 621, column: 51 } },
							})
						: e),
				) +
				"' for='" +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 621, column: 58 }, end: { line: 621, column: 64 } },
							})
						: e),
				) +
				"'>" +
				s(
					((e = (e = u(o, 'label') || (t != null ? u(t, 'label') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 621, column: 66 }, end: { line: 621, column: 75 } },
							})
						: e),
				) +
				`</label>
									<input
										class='form-input ` +
				s(
					((e =
						(e = u(o, 'inputRequired') || (t != null ? u(t, 'inputRequired') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 623, column: 28 }, end: { line: 623, column: 45 } },
							})
						: e),
				) +
				`'
										type='file'
										id='` +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 625, column: 14 }, end: { line: 625, column: 20 } },
							})
						: e),
				) +
				`'
										name='` +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 626, column: 16 }, end: { line: 626, column: 22 } },
							})
						: e),
				) +
				`'
										accept='` +
				s(
					((e =
						(e = u(o, 'acceptFileTypes') || (t != null ? u(t, 'acceptFileTypes') : t)) != null
							? e
							: i),
					typeof e === r
						? e.call(l, {
								name: 'acceptFileTypes',
								hash: {},
								data: a,
								loc: { start: { line: 627, column: 18 }, end: { line: 627, column: 37 } },
							})
						: e),
				) +
				`'
										` +
				s(
					((e =
						(e = u(o, 'multipleFiles') || (t != null ? u(t, 'multipleFiles') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'multipleFiles',
								hash: {},
								data: a,
								loc: { start: { line: 628, column: 10 }, end: { line: 628, column: 27 } },
							})
						: e),
				) +
				`
										placeholder="` +
				s(
					((e = (e = u(o, 'placeholder') || (t != null ? u(t, 'placeholder') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'placeholder',
								hash: {},
								data: a,
								loc: { start: { line: 629, column: 23 }, end: { line: 629, column: 38 } },
							})
						: e),
				) +
				`"
									/>
									<button class="clear-button">&times;</button>
									<p class='` +
				s(
					((e = (e = u(o, 'errorId') || (t != null ? u(t, 'errorId') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'errorId',
								hash: {},
								data: a,
								loc: { start: { line: 632, column: 19 }, end: { line: 632, column: 30 } },
							})
						: e),
				) +
				` error-hidden'>
										This field is required
									</p>
								</div>
`
			);
		},
		24: function (n, t, o, d, a) {
			var e,
				l = t ?? (n.nullContext || {}),
				i = n.hooks.helperMissing,
				r = 'function',
				s = n.escapeExpression,
				u =
					n.lookupProperty ||
					function (c, m) {
						if (Object.prototype.hasOwnProperty.call(c, m)) return c[m];
					};
			return (
				`								<div class='form-group'>
									<label class='form-label ` +
				s(
					((e =
						(e = u(o, 'inputRequired') || (t != null ? u(t, 'inputRequired') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 640, column: 34 }, end: { line: 640, column: 51 } },
							})
						: e),
				) +
				"' for='" +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 640, column: 58 }, end: { line: 640, column: 64 } },
							})
						: e),
				) +
				"'>" +
				s(
					((e = (e = u(o, 'label') || (t != null ? u(t, 'label') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'label',
								hash: {},
								data: a,
								loc: { start: { line: 640, column: 66 }, end: { line: 640, column: 75 } },
							})
						: e),
				) +
				`</label>
									<input
										class='form-input ` +
				s(
					((e =
						(e = u(o, 'inputRequired') || (t != null ? u(t, 'inputRequired') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'inputRequired',
								hash: {},
								data: a,
								loc: { start: { line: 642, column: 28 }, end: { line: 642, column: 45 } },
							})
						: e),
				) +
				`'
										type='` +
				s(
					((e = (e = u(o, 'type') || (t != null ? u(t, 'type') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'type',
								hash: {},
								data: a,
								loc: { start: { line: 643, column: 16 }, end: { line: 643, column: 24 } },
							})
						: e),
				) +
				`'
										id='` +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 644, column: 14 }, end: { line: 644, column: 20 } },
							})
						: e),
				) +
				`'
										name='` +
				s(
					((e = (e = u(o, 'id') || (t != null ? u(t, 'id') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'id',
								hash: {},
								data: a,
								loc: { start: { line: 645, column: 16 }, end: { line: 645, column: 22 } },
							})
						: e),
				) +
				`'
										value="` +
				s(
					((e =
						(e = u(o, 'defaultValue') || (t != null ? u(t, 'defaultValue') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'defaultValue',
								hash: {},
								data: a,
								loc: { start: { line: 646, column: 17 }, end: { line: 646, column: 33 } },
							})
						: e),
				) +
				`"
										placeholder="` +
				s(
					((e = (e = u(o, 'placeholder') || (t != null ? u(t, 'placeholder') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'placeholder',
								hash: {},
								data: a,
								loc: { start: { line: 647, column: 23 }, end: { line: 647, column: 38 } },
							})
						: e),
				) +
				`"
									/>
									<p class='` +
				s(
					((e = (e = u(o, 'errorId') || (t != null ? u(t, 'errorId') : t)) != null ? e : i),
					typeof e === r
						? e.call(l, {
								name: 'errorId',
								hash: {},
								data: a,
								loc: { start: { line: 649, column: 19 }, end: { line: 649, column: 30 } },
							})
						: e),
				) +
				` error-hidden'>
										This field is required
									</p>
								</div>
`
			);
		},
		25: function (n, t, o, d, a) {
			return "<p id='submit-error'></p>";
		},
		26: function (n, t, o, d, a) {
			return "disabled title='Connect the required accounts first'";
		},
		27: function (n, t, o, d, a) {
			return `						<p id='submit-hint'>This form will run using your connected accounts.</p>
`;
		},
		28: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"							<h1 id='submitted-header'>" +
				n.escapeExpression(
					((e =
						(e = l(o, 'formSubmittedHeader') || (t != null ? l(t, 'formSubmittedHeader') : t)) !=
						null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'formSubmittedHeader',
								hash: {},
								data: a,
								loc: { start: { line: 681, column: 33 }, end: { line: 681, column: 56 } },
							})
						: e),
				) +
				`</h1>
`
			);
		},
		29: function (n, t, o, d, a) {
			return `							<h1 id='submitted-header'>Form Submitted</h1>
`;
		},
		30: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				`							<p id='submitted-content'>
								` +
				n.escapeExpression(
					((e =
						(e = l(o, 'formSubmittedText') || (t != null ? l(t, 'formSubmittedText') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'formSubmittedText',
								hash: {},
								data: a,
								loc: { start: { line: 687, column: 8 }, end: { line: 687, column: 29 } },
							})
						: e),
				) +
				`
							</p>
`
			);
		},
		31: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				`					<hr>
					<div class='n8n-link'>
						<a href='` +
				n.escapeExpression(
					((e =
						(e = l(o, 'n8nWebsiteLink') || (t != null ? l(t, 'n8nWebsiteLink') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'n8nWebsiteLink',
								hash: {},
								data: a,
								loc: { start: { line: 696, column: 15 }, end: { line: 696, column: 33 } },
							})
						: e),
				) +
				`' target='_blank'>
							Form automated with
							<svg
								width='73'
								height='20'
								viewBox='0 0 73 20'
								fill='none'
								xmlns='http://www.w3.org/2000/svg'
							>
								<path
									fill-rule='evenodd'
									clip-rule='evenodd'
									d='M40.2373 4C40.2373 6.20915 38.4464 8 36.2373 8C34.3735 8 32.8074 6.72525 32.3633 5H26.7787C25.801 5 24.9666 5.70685 24.8059 6.6712L24.6415 7.6576C24.4854 8.59415 24.0116 9.40925 23.3417 10C24.0116 10.5907 24.4854 11.4058 24.6415 12.3424L24.8059 13.3288C24.9666 14.2931 25.801 15 26.7787 15H28.3633C28.8074 13.2747 30.3735 12 32.2373 12C34.4464 12 36.2373 13.7908 36.2373 16C36.2373 18.2092 34.4464 20 32.2373 20C30.3735 20 28.8074 18.7253 28.3633 17H26.7787C24.8233 17 23.1546 15.5864 22.8331 13.6576L22.6687 12.6712C22.508 11.7069 21.6736 11 20.6959 11H19.0645C18.5652 12.64 17.0406 13.8334 15.2373 13.8334C13.434 13.8334 11.9094 12.64 11.4101 11H9.06449C8.56519 12.64 7.04059 13.8334 5.2373 13.8334C3.02817 13.8334 1.2373 12.0424 1.2373 9.83335C1.2373 7.6242 3.02817 5.83335 5.2373 5.83335C7.16069 5.83335 8.76699 7.19085 9.15039 9H11.3242C11.7076 7.19085 13.3139 5.83335 15.2373 5.83335C17.1607 5.83335 18.767 7.19085 19.1504 9H20.6959C21.6736 9 22.508 8.29315 22.6687 7.3288L22.8331 6.3424C23.1546 4.41365 24.8233 3 26.7787 3H32.3633C32.8074 1.27478 34.3735 0 36.2373 0C38.4464 0 40.2373 1.79086 40.2373 4ZM38.2373 4C38.2373 5.10455 37.3419 6 36.2373 6C35.1327 6 34.2373 5.10455 34.2373 4C34.2373 2.89543 35.1327 2 36.2373 2C37.3419 2 38.2373 2.89543 38.2373 4ZM5.2373 11.8334C6.34189 11.8334 7.23729 10.9379 7.23729 9.83335C7.23729 8.72875 6.34189 7.83335 5.2373 7.83335C4.13273 7.83335 3.2373 8.72875 3.2373 9.83335C3.2373 10.9379 4.13273 11.8334 5.2373 11.8334ZM15.2373 11.8334C16.3419 11.8334 17.2373 10.9379 17.2373 9.83335C17.2373 8.72875 16.3419 7.83335 15.2373 7.83335C14.1327 7.83335 13.2373 8.72875 13.2373 9.83335C13.2373 10.9379 14.1327 11.8334 15.2373 11.8334ZM32.2373 18C33.3419 18 34.2373 17.1045 34.2373 16C34.2373 14.8954 33.3419 14 32.2373 14C31.1327 14 30.2373 14.8954 30.2373 16C30.2373 17.1045 31.1327 18 32.2373 18Z'
									fill='#EA4B71'
								/>
								<path
									d='M44.2393 15.0007H46.3277V10.5791C46.3277 9.12704 47.2088 8.49074 48.204 8.49074C49.183 8.49074 49.9498 9.14334 49.9498 10.4812V15.0007H52.038V10.057C52.038 7.91969 50.798 6.67969 48.8567 6.67969C47.633 6.67969 46.9477 7.16914 46.4582 7.80544H46.3277L46.1482 6.84284H44.2393V15.0007Z'
									fill='#101330'
								/>
								<path
									d='M60.0318 9.50205V9.40415C60.7498 9.0452 61.4678 8.4252 61.4678 7.20155C61.4678 5.43945 60.0153 4.37891 58.0088 4.37891C55.9528 4.37891 54.4843 5.5047 54.4843 7.23415C54.4843 8.4089 55.1698 9.0452 55.9203 9.40415V9.50205C55.0883 9.79575 54.0928 10.6768 54.0928 12.1452C54.0928 13.9237 55.5613 15.1637 57.9923 15.1637C60.4233 15.1637 61.8428 13.9237 61.8428 12.1452C61.8428 10.6768 60.8638 9.81205 60.0318 9.50205ZM57.9923 5.87995C58.8083 5.87995 59.4118 6.40205 59.4118 7.2831C59.4118 8.16415 58.7918 8.6863 57.9923 8.6863C57.1928 8.6863 56.5238 8.16415 56.5238 7.2831C56.5238 6.38575 57.1603 5.87995 57.9923 5.87995ZM57.9923 13.5974C57.0458 13.5974 56.2793 12.9937 56.2793 11.9658C56.2793 11.0358 56.9153 10.3342 57.9758 10.3342C59.0203 10.3342 59.6568 11.0195 59.6568 11.9984C59.6568 12.9937 58.9223 13.5974 57.9923 13.5974Z'
									fill='#101330'
								/>
								<path
									d='M63.9639 15.0007H66.0524V10.5791C66.0524 9.12704 66.9334 8.49074 67.9289 8.49074C68.9079 8.49074 69.6744 9.14334 69.6744 10.4812V15.0007H71.7629V10.057C71.7629 7.91969 70.5229 6.67969 68.5814 6.67969C67.3579 6.67969 66.6724 7.16914 66.1829 7.80544H66.0524L65.8729 6.84284H63.9639V15.0007Z'
									fill='#101330'
								/>
							</svg>
						</a>
					</div>
`
			);
		},
		32: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				"					<a id='redirectUrl' href='" +
				n.escapeExpression(
					((e =
						(e = l(o, 'redirectUrl') || (t != null ? l(t, 'redirectUrl') : t)) != null
							? e
							: n.hooks.helperMissing),
					typeof e == 'function'
						? e.call(t ?? (n.nullContext || {}), {
								name: 'redirectUrl',
								hash: {},
								data: a,
								loc: { start: { line: 729, column: 31 }, end: { line: 729, column: 46 } },
							})
						: e),
				) +
				`' style='display: none;'></a>
`
			);
		},
		33: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				`				// True when this form is the inner frame of the hosting shell, which owns the
				// connect panel and the submit button's enabled state.
				const isShellInner = ` +
				((e = l(o, 'if').call(t ?? (n.nullContext || {}), t != null ? l(t, 'shellInner') : t, {
					name: 'if',
					hash: {},
					fn: n.program(34, a, 0),
					inverse: n.program(35, a, 0),
					data: a,
					loc: { start: { line: 753, column: 25 }, end: { line: 753, column: 67 } },
				})) != null
					? e
					: '') +
				`;

				// The submit-time credential gate refused this submission. Explain it and hand the
				// form back with the answers intact. The panel names the accounts, so the banner
				// only has to say what to do next.
				function handleCredentialGate(credentials) {
					updateError(
						document.querySelector('#submit-error'),
						'add',
						'Not all required accounts are connected. ' +
							(isShellInner
								? 'Connect them above, then submit again.'
								: 'Open this form in a new tab to connect them, then come back here and submit again.'),
					);

					const btn = document.querySelector('#submit-btn');
					btn.style.cursor = '';
					btn.querySelector('span').style.display = '';

					if (isShellInner) {
						// The shell owns the disabled state, so hand it the rows it still shows as
						// connected and let its readiness signal re-disable Submit. Ids only: it must
						// not have to trust a name or a URL from this frame. targetOrigin '*' because
						// the frame is sandboxed without allow-same-origin and can't know the parent's.
						window.parent.postMessage(
							{
								type: 'n8n-form-credentials-rejected',
								// The body lists every required credential, connected ones included.
								ids: credentials.filter((c) => c.credentialStatus !== 'configured').map((c) => c.credentialId),
							},
							'*',
						);
					} else {
						btn.disabled = false;
					}
				}
`
			);
		},
		34: function (n, t, o, d, a) {
			return 'true';
		},
		35: function (n, t, o, d, a) {
			return 'false';
		},
		36: function (n, t, o, d, a) {
			return "updateError(document.querySelector('#submit-error'), 'remove');";
		},
		37: function (n, t, o, d, a) {
			return `								// A credential-gate rejection keeps the submitter on the page with their
								// answers, so handle it before the useResponseData branch below paints the
								// response body over the whole document.
								if (response.status === 428) {
									// Clone: that branch reads the body too, and a body can only be read once.
									// Any other 428 \u2014 the webhook trigger's gate has no \`status\` \u2014 falls
									// through untouched.
									const gate = await response.clone().json().catch(() => null);
									if (gate && gate.status === 'credential_connections_required') {
										handleCredentialGate(gate.credentials);
										return;
									}
								}
`;
		},
		38: function (n, t, o, d, a) {
			var e,
				l =
					n.lookupProperty ||
					function (i, r) {
						if (Object.prototype.hasOwnProperty.call(i, r)) return i[r];
					};
			return (
				`		<script>
			// Toggle submit on the hosting shell's readiness signals; the server-side
			// POST gate is the real enforcement.
			window.addEventListener('message', function (event) {
				if (event.source !== window.parent) return;
				if (!event.data) return;
				var btn = document.getElementById('submit-btn');
				if (!btn) return;
				if (event.data.type === 'n8n-shell-credentials-ready') {
					btn.disabled = false;
					btn.removeAttribute('title');
` +
				((e = l(o, 'if').call(
					t ?? (n.nullContext || {}),
					t != null ? l(t, 'hasAuthenticatedSubmitter') : t,
					{
						name: 'if',
						hash: {},
						fn: n.program(39, a, 0),
						inverse: n.noop,
						data: a,
						loc: { start: { line: 1230, column: 5 }, end: { line: 1236, column: 12 } },
					},
				)) != null
					? e
					: '') +
				`				} else if (event.data.type === 'n8n-shell-credentials-not-ready') {
					btn.disabled = true;
					btn.setAttribute('title', 'Connect the required accounts first');
				}
			});
		</script>
`
			);
		},
		39: function (n, t, o, d, a) {
			return `						// A rejection banner asking for the credentials is stale once the panel
						// reports them connected. Guarded because shellInner comes from a query
						// param, so a form with no submitter identity \u2014 and so no banner in the
						// markup \u2014 can still render this listener.
						updateError(document.querySelector('#submit-error'), 'remove');
`;
		},
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a, e, l) {
			var i,
				r,
				s = t ?? (n.nullContext || {}),
				u = n.hooks.helperMissing,
				c = 'function',
				m = n.escapeExpression,
				f =
					n.lookupProperty ||
					function (p, g) {
						if (Object.prototype.hasOwnProperty.call(p, g)) return p[g];
					};
			return (
				`<!DOCTYPE html>
<html lang='en'>
	<head>
		<meta charset='UTF-8' />
		<meta name='viewport' content='width=device-width, initial-scale=1.0' />
		<meta name="description" content="` +
				m(
					((r =
						(r =
							f(o, 'formDescriptionMetadata') ||
							(t != null ? f(t, 'formDescriptionMetadata') : t)) != null
							? r
							: u),
					typeof r === c
						? r.call(s, {
								name: 'formDescriptionMetadata',
								hash: {},
								data: a,
								loc: { start: { line: 6, column: 36 }, end: { line: 6, column: 63 } },
							})
						: r),
				) +
				`" />
		<meta property="og:title" content="` +
				m(
					((r = (r = f(o, 'formTitle') || (t != null ? f(t, 'formTitle') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'formTitle',
								hash: {},
								data: a,
								loc: { start: { line: 7, column: 37 }, end: { line: 7, column: 50 } },
							})
						: r),
				) +
				`" />
		<meta property="og:description" content="` +
				m(
					((r =
						(r =
							f(o, 'formDescriptionMetadata') ||
							(t != null ? f(t, 'formDescriptionMetadata') : t)) != null
							? r
							: u),
					typeof r === c
						? r.call(s, {
								name: 'formDescriptionMetadata',
								hash: {},
								data: a,
								loc: { start: { line: 8, column: 43 }, end: { line: 8, column: 70 } },
							})
						: r),
				) +
				`" />
		<meta property="og:type" content="website" />
		<meta property="og:image" content="/static/og_image.png" />
		<link rel='icon' type='image/png' href='https://n8n.io/favicon.ico' />
		<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
		<title>` +
				m(
					((r = (r = f(o, 'formTitle') || (t != null ? f(t, 'formTitle') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'formTitle',
								hash: {},
								data: a,
								loc: { start: { line: 13, column: 9 }, end: { line: 13, column: 22 } },
							})
						: r),
				) +
				`</title>
		<style>
			:root {
				/* Fonts */
				--font-family: "Open Sans", sans-serif;
				--font-size-body: 12px;
				--font-size-label: 14px;
				--font-size-test-notice: 12px;
				--font-size-input: 14px;
				--font-size-header: 20px;
				--font-size-paragraph: 14px;
				--font-size-link: 12px;
				--font-size-error: 12px;
				--font-size-html-h1: 28px;
				--font-size-html-h2: 20px;
				--font-size-html-h3: 16px;
				--font-size-html-h4: 14px;
				--font-size-html-h5: 12px;
				--font-size-html-h6: 10px;

				/* Colors */
				--color-background: #fbfcfe;
				--color-test-notice-text: #e6a23d;
				--color-test-notice-bg: #fefaf6;
				--color-test-notice-border: #f6dcb7;
				--color-card-bg: #ffffff;
				--color-card-border: #dbdfe7;
				--color-card-shadow: rgba(99, 77, 255, 0.06);
				--color-link: #7e8186;
				--color-header: #525356;
				--color-label: #555555;
				--color-input-border: #dbdfe7;
				--color-input-text: #71747A;
				--color-input-bg: #ffffff;
				--color-focus-border: rgb(90, 76, 194);
				--color-submit-btn-bg: #ff6d5a;
				--color-submit-btn-text: #ffffff;
				--color-error: #ea1f30;
				--color-required: #ff6d5a;
				--color-clear-button-bg: #7e8186;
				--color-html-text: #555;
				--color-html-link: #FF6D5A;

				/* Border Radii */
				--border-radius-card: 8px;
				--border-radius-input: 6px;
				--border-radius-clear-btn: 50%;

				/* Spacing */
				--padding-container-top: 24px;
				--padding-card: 24px;
				--padding-test-notice-vertical: 12px;
				--padding-test-notice-horizontal: 24px;
				--margin-bottom-card: 16px;
				--padding-form-input: 12px;

				/* Dimensions */
				--container-width: 448px;
				--submit-btn-height: 48px;
				--checkbox-size: 18px;

				/* Others */
				--box-shadow-card: 0px 4px 16px 0px var(--color-card-shadow);
				--opacity-placeholder: 0.5;
			}

			*,
			::after,
			::before {
				box-sizing: border-box;
				margin: 0;
				padding: 0;
			}

			body {
				font-family: var(--font-family);
				font-weight: 400;
				font-size: var(--font-size-body);
				display: flex;
				flex-direction: column;
				justify-content: start;
				background-color: var(--color-background);
			}

			.container {
				margin: auto;
				text-align: center;
				padding-top: var(--padding-container-top);
				width: var(--container-width);
			}

			.test-notice {
				padding: var(--padding-test-notice-vertical) var(--padding-test-notice-horizontal);
				color: var(--color-test-notice-text);
				background-color: var(--color-test-notice-bg);
				border-radius: var(--border-radius-card);
				border: 1px solid var(--color-test-notice-border);
				font-size: var(--font-size-test-notice);
				font-weight: 400;
				line-height: 16px;
				text-align: left;
				margin-bottom: var(--margin-bottom-card);
			}

			.card {
				padding: var(--padding-card);
				background-color: var(--color-card-bg);
				border: 1px solid var(--color-card-border);
				border-radius: var(--border-radius-card);
				box-shadow: var(--box-shadow-card);
				margin-bottom: var(--margin-bottom-card);
			}

			.n8n-link {
				padding-bottom: var(--padding-container-top);
			}
			.n8n-link a {
				color: var(--color-link);
				font-weight: 600;
				font-size: var(--font-size-link);
				text-decoration: none;
			}

			.n8n-link svg {
				display: inline-block;
				vertical-align: middle;
			}

			.form-header h1 {
				color: var(--color-header);
				font-size: var(--font-size-header);
				font-weight: 400;
			}

			.form-header p {
				padding-top: 8px;
				color: var(--color-link);
				font-size: var(--font-size-paragraph);
				font-weight: 400;
			}

			.inputs-wrapper {
				padding-top: var(--padding-container-top);
				padding-bottom: var(--padding-container-top);
			}

			form label {
				display: block;
				text-align: left;
				font-size: var(--font-size-label);
				font-weight: 600;
				color: var(--color-label);
				padding-bottom: 6px;
			}

			form textarea {
				max-width: 100%;
			}

			form .form-input {
				border: 1px solid var(--color-input-border);
				border-radius: var(--border-radius-input);
				width: 100%;
				font-size: var(--font-size-input);
				color: var(--color-input-text);
				background-color: var(--color-input-bg);
				font-weight: 400;
				padding: var(--padding-form-input);
			}

			form textarea:focus,
			form input:focus {
				outline: none;
				border-color: var(--color-focus-border);
			}

			.select-input {
				border: 1px solid var(--color-input-border);
				border-radius: var(--border-radius-input);
			}

			.select-input:focus-within {
				border: 1px solid var(--color-focus-border);
			}

			form select {
				outline: transparent;
				border: none;
				border-radius: var(--border-radius-input);
				width: 100%;
				font-size: var(--font-size-input);
				color: var(--color-input-text);
				font-weight: 400;
				background-color: var(--color-card-bg);
				padding: var(--padding-form-input);
				border-right: 12px solid transparent;
			}

			input[type='date'] {
				font-family: var(--font-family);
			}

			::placeholder {
				opacity: var(--opacity-placeholder);
			}

			#submit-btn {
				width: 100%;
				height: var(--submit-btn-height);
				padding: var(--padding-form-input);
				border-radius: var(--border-radius-input);
				border: 0;
				font-size: var(--font-size-input);
				font-weight: 600;
				font-family: var(--font-family);
				background-color: var(--color-submit-btn-bg);
				color: var(--color-submit-btn-text);
				cursor: pointer;
			}

			#submit-btn span {
				padding-right: 6px;
				display: none;
			}

			#submit-btn span svg {
				display: inline-block;
				vertical-align: middle;
				fill: var(--color-submit-btn-text);
				animation: lds-ring 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
			}

			@keyframes lds-ring {
				0% {
					transform: rotate(0deg);
				}
				100% {
					transform: rotate(360deg);
				}
			}

			#submit-btn:hover {
				opacity: 0.7;
			}

			#submit-btn:disabled {
				background-color: #e9eaec;
				color: #9aa0a6;
				cursor: not-allowed;
			}

			#submit-hint {
				margin-top: 8px;
				font-size: var(--font-size-link);
				color: var(--color-link);
			}

			#submit-btn:disabled:hover {
				opacity: 1;
			}

			.error-hidden {
				display: block;
				position: relative;
				color: var(--color-error);
				text-align: left;
				font-size: var(--font-size-error);
				font-weight: 400;
				visibility: hidden;
				padding-top: 6px;
				padding-bottom: 9px;
			}

			.error-show {
				visibility: visible;
			}

` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'hasAuthenticatedSubmitter') : t, {
					name: 'if',
					hash: {},
					fn: n.program(0, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 290, column: 3 }, end: { line: 305, column: 10 } },
				})) != null
					? i
					: '') +
				`
			/* multiselect ----------------------------------- */
			.multiselect {
				padding-left: 6px;
				padding-right: 6px;
			}

			.multiselect-option {
				padding-top: 6px;
				display: flex;
			}

			.multiselect-option label {
				padding-left: 12px;
				color: var(--color-link);
				font-weight: 400;
				cursor: pointer;
			}

			.multiselect-checkbox {
				vertical-align: middle;
				min-width: var(--checkbox-size);
			}

			input[type='checkbox'] {
				appearance: none;
				width: var(--checkbox-size);
				height: var(--checkbox-size);
				border: 1px solid var(--color-input-border);
				border-radius: 3px;
				cursor: pointer;
				position: relative;
			}
			.multiselect-checkbox:checked {
				background: var(--color-focus-border);
				border-color: var(--color-focus-border);
			}
			.multiselect-checkbox:checked::after {
				content: '\u2714';
				position: absolute;
				top: 50%;
				left: 50%;
				transform: translate(-50%, -50%);
				color: white;
				font-size: var(--font-size-label);
				font-weight: bold;
			}

			.multiselect[data-radio-select] .multiselect-checkbox {
				border-radius: 50%;
				width: var(--checkbox-size);
				height: var(--checkbox-size);
				display: flex;
				align-items: center;
				justify-content: center;
			}

			.multiselect[data-radio-select] .multiselect-checkbox:checked {
				background: white;
				border-color: var(--color-focus-border);
				border-width: 4px;
				border-radius: 50%;
			}
			.multiselect[data-radio-select] .multiselect-checkbox:checked::after {
				content: '';
			}
			/* required field ----------------------------- */
			.form-required {
			}
			label.form-required::after {
				content: ' *';
				color: var(--color-required);
			}

			hr {
				border: 0;
				height: 1px;
				border-top: 1px solid var(--color-input-border);
				margin-top: 24px;
				margin-bottom: 24px;
				display: none;
			}

			.file-input-wrapper {
				position: relative;
				display: inline-block;
				width: 100%;
			}
			input[type="file"] {
			}
			.clear-button {
				position: absolute;
				right: 5px;
				top: 50%;
				transform: translateY(-65%);
				background-color: var(--color-clear-button-bg);
				border: none;
				border-radius: var(--border-radius-clear-btn);
				font-size: 14px;
				font-weight: 600;
				font-family: var(--font-family);
				color: white;
				width: 20px;
				height: 20px;
				text-align: center;
				line-height: 20px;
				cursor: pointer;
				display: none;
			}
			input[type="file"]:not(:empty) + .clear-button {
				display: inline-block;
			}

			div.html {
				text-align: left;
				color: var(--color-html-text);
				font-size: var(--font-size-input);
			}
			div.html h1, div.html h2, div.html h3, div.html h4, div.html h5, div.html h6, div.html p, div.html ul, div.html ol, div.html a {
				font-weight: 400;
				font-style: normal;
				margin-bottom: 8px;
			}
			div.html li {
				margin-bottom: 8px;
				margin-left: 24px;
			}
			div.html ul, div.html ol {
				font-size: var(--font-size-input);
				display: flex;
				flex-direction: column;
				align-self: stretch;
				line-height: normal;
			}
			div.html b {
				font-weight: 600;
			}
			div.html h1 {
				font-size: var(--font-size-html-h1);
				line-height: 35px;
			}
			div.html h2 {
				font-size: var(--font-size-html-h2);
				line-height: 26px;
			}
			div.html h3 {
				font-size: var(--font-size-html-h3);
				line-height: 24px;
			}
			div.html h4 {
				font-size: var(--font-size-html-h4);
				line-height: 18px;
			}
			div.html h5 {
				font-size: var(--font-size-html-h5);
			}
			div.html h6 {
				font-size: var(--font-size-html-h6);
			}
			div.html p {
				margin-bottom: 8px;
			}
			div.html a {
				color: var(--color-html-link);
				font-size: var(--font-size-input);
			}

			@media only screen and (max-width: 500px) {
				body {
					background-color: var(--color-background);
				}
				hr {
					display: block;
				}
				.container {
					width: 95%;
					min-height: 100vh;
					padding: 24px;
					border: 0px solid var(--color-input-border);
					border-radius: 0px;
					box-shadow: 0px 0px 0px 0px #ffffff;
				}
				.card {
					padding: 0px;
					background-color: var(--color-card-bg);
					border: 0px solid var(--color-input-border);
					border-radius: 0px;
					box-shadow: 0px 0px 0px 0px #ffffff;
					margin-bottom: 0px;
				}
			}
		</style>

` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'dangerousCustomCss') : t, {
					name: 'if',
					hash: {},
					fn: n.program(1, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 499, column: 2 }, end: { line: 503, column: 9 } },
				})) != null
					? i
					: '') +
				`	</head>

	<body>
		<div class='container'>
			<section>
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'testRun') : t, {
					name: 'if',
					hash: {},
					fn: n.program(2, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 509, column: 4 }, end: { line: 514, column: 11 } },
				})) != null
					? i
					: '') +
				`
				<form class='card' action='#' method='POST' name='n8n-form' id='n8n-form' novalidate>
					<div class='form-header'>
						<h1>` +
				m(
					((r = (r = f(o, 'formTitle') || (t != null ? f(t, 'formTitle') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'formTitle',
								hash: {},
								data: a,
								loc: { start: { line: 518, column: 10 }, end: { line: 518, column: 23 } },
							})
						: r),
				) +
				`</h1>
						<p style="white-space: pre-line">` +
				((i =
					((r =
						(r = f(o, 'formDescription') || (t != null ? f(t, 'formDescription') : t)) != null
							? r
							: u),
					typeof r === c
						? r.call(s, {
								name: 'formDescription',
								hash: {},
								data: a,
								loc: { start: { line: 519, column: 39 }, end: { line: 519, column: 60 } },
							})
						: r)) != null
					? i
					: '') +
				` </p>
					</div>

					<div class='inputs-wrapper'>
` +
				((i = f(o, 'each').call(s, t != null ? f(t, 'formFields') : t, {
					name: 'each',
					hash: {},
					fn: n.program(3, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 523, column: 6 }, end: { line: 654, column: 15 } },
				})) != null
					? i
					: '') +
				`					</div>

					` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'hasAuthenticatedSubmitter') : t, {
					name: 'if',
					hash: {},
					fn: n.program(25, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 657, column: 5 }, end: { line: 657, column: 70 } },
				})) != null
					? i
					: '') +
				`

					<button id='submit-btn' type='submit' ` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'shellInner') : t, {
					name: 'if',
					hash: {},
					fn: n.program(26, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 659, column: 43 }, end: { line: 659, column: 120 } },
				})) != null
					? i
					: '') +
				`>
						<span><svg
								xmlns='http://www.w3.org/2000/svg'
								height='18px'
								viewBox='0 0 512 512'
							>
								<path
									d='M304 48a48 48 0 1 0 -96 0 48 48 0 1 0 96 0zm0 416a48 48 0 1 0 -96 0 48 48 0 1 0 96 0zM48 304a48 48 0 1 0 0-96 48 48 0 1 0 0 96zm464-48a48 48 0 1 0 -96 0 48 48 0 1 0 96 0zM142.9 437A48 48 0 1 0 75 369.1 48 48 0 1 0 142.9 437zm0-294.2A48 48 0 1 0 75 75a48 48 0 1 0 67.9 67.9zM369.1 437A48 48 0 1 0 437 369.1 48 48 0 1 0 369.1 437z'
								/>
							</svg></span>
						` +
				m(
					((r = (r = f(o, 'buttonLabel') || (t != null ? f(t, 'buttonLabel') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'buttonLabel',
								hash: {},
								data: a,
								loc: { start: { line: 669, column: 6 }, end: { line: 669, column: 23 } },
							})
						: r),
				) +
				`
					</button>

` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'shellInner') : t, {
					name: 'if',
					hash: {},
					fn: n.program(27, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 672, column: 5 }, end: { line: 675, column: 12 } },
				})) != null
					? i
					: '') +
				`				</form>

				<div class='card' id='submitted-form' style='display: none;'>
					<div class='form-header'>
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'formSubmittedHeader') : t, {
					name: 'if',
					hash: {},
					fn: n.program(28, a, 0, e, l),
					inverse: n.program(29, a, 0, e, l),
					data: a,
					loc: { start: { line: 680, column: 6 }, end: { line: 684, column: 13 } },
				})) != null
					? i
					: '') +
				((i = f(o, 'if').call(s, t != null ? f(t, 'formSubmittedText') : t, {
					name: 'if',
					hash: {},
					fn: n.program(30, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 685, column: 6 }, end: { line: 689, column: 13 } },
				})) != null
					? i
					: '') +
				`					</div>
				</div>

` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'appendAttribution') : t, {
					name: 'if',
					hash: {},
					fn: n.program(31, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 693, column: 4 }, end: { line: 726, column: 11 } },
				})) != null
					? i
					: '') +
				`
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'redirectUrl') : t, {
					name: 'if',
					hash: {},
					fn: n.program(32, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 728, column: 4 }, end: { line: 730, column: 11 } },
				})) != null
					? i
					: '') +
				'				<input id="useResponseData" style="display: none;" value=' +
				m(
					((r =
						(r = f(o, 'useResponseData') || (t != null ? f(t, 'useResponseData') : t)) != null
							? r
							: u),
					typeof r === c
						? r.call(s, {
								name: 'useResponseData',
								hash: {},
								data: a,
								loc: { start: { line: 731, column: 61 }, end: { line: 731, column: 80 } },
							})
						: r),
				) +
				` />
			</section>
		</div>
		<script>
			// Get signature from URL for fetch requests
			const url = new URL(window.location.href);
			let formSignature = url.searchParams.get('signature');

` +
				((i = n.invokePartial(f(d, 'formHostNavigation'), t, {
					name: 'formHostNavigation',
					hash: { withRedirect: !0, path: t != null ? f(t, 'hostNavigationPath') : t },
					data: a,
					indent: '			',
					helpers: o,
					partials: d,
					decorators: n.decorators,
				})) != null
					? i
					: '') +
				`
			function updateError(errorElement, action = 'add', message = '') {
				if(action === 'add') {
					errorElement.textContent = message;
					errorElement.classList.add('error-show');
				} else {
					errorElement.classList.remove('error-show');
				}
			}

` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'hasAuthenticatedSubmitter') : t, {
					name: 'if',
					hash: {},
					fn: n.program(33, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 750, column: 3 }, end: { line: 789, column: 10 } },
				})) != null
					? i
					: '') +
				`
			function validateInput(input, errorElement) {
				const value = input.value.trim();
				const type = input.type;

				if (type === 'email' && value !== '') {
					return validateEmailInput(value, errorElement);
				} else if (type === 'number' && value !== '') {
					if (isNaN(value)) {
						updateError(errorElement, 'add', 'Enter only numbers in this field');
						return false;
					} else {
						updateError(errorElement, 'remove');
						return true;
					}
				} else if (value === '') {
					updateError(errorElement, 'add', 'This field is required');
					return false;
				} else {
					updateError(errorElement, 'remove');
					return true;
				}
			}

			function validateEmailInput(value, errorElement) {
				const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/;
				const isValidEmail = regex.test(value);

				if (!isValidEmail) {
					updateError(errorElement, 'add', 'Enter a valid email address in this field');
					return false;
				} else {
					errorElement.textContent = 'This field is required';
					updateError(errorElement, 'remove');
					return true;
				}
			}

			function getSelectedValues(input) {
				const selectedValues = [];
				const checkboxes = input.querySelectorAll('.multiselect-checkbox');

				checkboxes.forEach((checkbox, index) => {
					if (checkbox.checked) {
						selectedValues.push(checkbox.value.trim());
					}
				});

				return selectedValues;
			}

			function getDataValues(input) {
				const radio = input.dataset.radioSelect ? true : false;
				const exact = input.dataset.exactSelect ? parseInt(input.dataset.exactSelect, 10) : null;
				const maxSelect = input.dataset.maxSelect ? parseInt(input.dataset.maxSelect, 10) : null;
				const minSelect = input.dataset.minSelect ? parseInt(input.dataset.minSelect, 10) : null;
				return { radio, exact, maxSelect, minSelect };
			}

			function validateMultiselect(input, errorElement) {
				const values = getSelectedValues(input);
				const data = getDataValues(input);
				const required = input.classList.contains('form-required');

				if (required && !values.length) {
					updateError(errorElement, 'add', 'This field is required');
					return false;
				}

				if (data.exact && values.length !== data.exact) {
					const optionText = data.exact === 1 ? 'option' : 'options';
					updateError(errorElement, 'add', \`You must select exactly \${data.exact} \${optionText}\`);
					return false;
				}

				if (data.minSelect && values.length < data.minSelect) {
					const optionText = data.minSelect === 1 ? 'option' : 'options';
					updateError(errorElement, 'add', \`You must select at least \${data.minSelect} \${optionText}\`);
					return false;
				}

				if(data.maxSelect && values.length > data.maxSelect) {
					const optionText = data.maxSelect === 1 ? 'option' : 'options';
					updateError(errorElement, 'add', \`You can select a maximum of \${data.maxSelect} \${optionText}\`);
					return false;
				}

				updateError(errorElement, 'remove');
				return true;
			}

			const form = document.querySelector('#n8n-form');

			document.querySelectorAll("input[type=number]").forEach(function (element) {
				element.addEventListener("wheel", function(event) {
					if (document.activeElement === event.target) {
						event.preventDefault();
					}
				});
			});

			document.querySelectorAll('input[type="file"]').forEach(fileInput => {
				const clearButton = fileInput.nextElementSibling;
				let previousFiles = [];

				fileInput.addEventListener('change', () => {
					const files = fileInput.files;

					if (files.length > 0) {
						previousFiles = Array.from(files);
						clearButton.style.display = 'inline-block';
					} else {
						if (previousFiles.length > 0) {
							const dataTransfer = new DataTransfer();
							previousFiles.forEach(file => dataTransfer.items.add(file));
							fileInput.files = dataTransfer.files;
							clearButton.style.display = 'inline-block';
						}
					}
				});

				clearButton.addEventListener('click', (event) => {
					event.preventDefault();
					fileInput.value = '';
					previousFiles = [];
					clearButton.style.display = 'none';
				});
			});

			const requiredInputs = document.querySelectorAll('.form-required:not(label)');
			const emailInputs = document.querySelectorAll("input[type=email]");
			const multiselectInputs = document.querySelectorAll('.multiselect');

			multiselectInputs.forEach((input) => {
				const data = getDataValues(input);
				const errorElement = document.querySelector(\`.error-\${input.id}\`);

				if (data.radio) {
					const checkboxes = input.querySelectorAll('.multiselect-checkbox');
					checkboxes.forEach((checkbox) => {
						checkbox.addEventListener('change', (event) => {
							if (event.target.checked) {
								checkboxes.forEach((cb) => {
									if (cb !== event.target) {
										cb.checked = false;
									}
								});
								updateError(errorElement, 'remove');
							}
						});
					});
				}

				input.addEventListener('click', () => {
					validateMultiselect(input, errorElement);
				});
			});

			requiredInputs.forEach((input) => {
				const errorSelector = \`.error-\${input.id}\`;
				const error = document.querySelector(errorSelector);

				if (input.classList.contains('multiselect')) {
					input.addEventListener('click', () => {
						validateMultiselect(input, error);
					});
				} else {
					input.addEventListener('blur', () => {
						validateInput(input, error);
					});
					input.addEventListener('input', () => {
						updateError(error, 'remove');
					});
				}
			});

			emailInputs.forEach(function (input) {
				const errorSelector = \`.error-\${input.id}\`;
				const error = document.querySelector(errorSelector);

				input.addEventListener("input", function(event) {
					const value = input.value.trim();
					if (value === "") {
						error.classList.remove('error-show');
					} else {
						validateEmailInput(value, error);
					}
				});
			});

			let interval = 1000;
			let timeoutId;
			let formWaitingUrl;

			const checkExecutionStatus = async () => {
				if (!interval) return;

				try {
					const baseUrl = formWaitingUrl ?? window.location.href;
					const url = new URL(baseUrl);
					url.pathname = url.pathname + '/n8n-execution-status';
					// Include signature in fetch request for validation
					if (formSignature) {
						url.searchParams.set('signature', formSignature);
					}
					const response = await fetch(url.toString());
					const text = (await response.text()).trim();

					if (text === "form-waiting") {
						// Redirect to form page with signature in URL (will be cleaned after load)
						const redirectUrl = new URL(formWaitingUrl ?? window.location.href);
						if (formSignature) {
							redirectUrl.searchParams.set('signature', formSignature);
						}
						navigateTo(redirectUrl.toString());
						return;
					}

					if (text === "success") {
						form.style.display = 'none';
						document.querySelector('#submitted-form').style.display = 'block';
						clearTimeout(timeoutId);
						return;
					}

					if (text === "null") {
						form.style.display = 'none';
						document.querySelector('#submitted-form').style.display = 'block';
						document.querySelector('#submitted-header').textContent = 'Could not get execution status';
						document.querySelector('#submitted-content').textContent =
							'Make sure "Save successful production executions" is enabled in your workflow settings';
						clearTimeout(timeoutId);
						return;
					}

					if(["canceled", "crashed", "error" ].includes(text)) {
						form.style.display = 'none';
						document.querySelector('#submitted-form').style.display = 'block';
						document.querySelector('#submitted-header').textContent = 'Problem submitting response';
						document.querySelector('#submitted-content').textContent =
							'Please try again or contact support if the problem persists';
						clearTimeout(timeoutId);
						return;
					}

					interval = Math.round(interval * 1.1);
					timeoutId = setTimeout(checkExecutionStatus, interval);
				} catch (error) {
					console.error("Error fetching data:", error);
				}
			};

			form.addEventListener('submit', (e) => {
				const valid = [];
				e.preventDefault();

				emailInputs.forEach(function (input) {
					const value = input.value.trim();
					if(value === '') {
						return;
					}
					const errorSelector = \`.error-\${input.id}\`;
					const error = document.querySelector(errorSelector);
					valid.push(validateEmailInput(value, error));
				});

				[...requiredInputs, ...multiselectInputs].forEach((input) => {
					const errorSelector = \`.error-\${input.id}\`;
					const error = document.querySelector(errorSelector);

					if (input.classList.contains('multiselect')) {
						valid.push(validateMultiselect(input, error));
					} else {
						valid.push(validateInput(input, error));
					}
				});

				if (valid.every((v) => v)) {
					var formData = new FormData();

					for (const filed of form.elements) {
						if(filed.type !== 'file') {
							formData.append(filed.name, filed.value);
						} else {
							for (const file of filed.files) {
								if(file.size === 0) {
									continue;
								}
								formData.append(filed.name, file);
							}
						}
					}
					document.querySelectorAll('.multiselect').forEach((multiselect) => {
 						const selectedValues = getSelectedValues(multiselect);
 						formData.append(multiselect.id, JSON.stringify(selectedValues));
 					});
					` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'hasAuthenticatedSubmitter') : t, {
					name: 'if',
					hash: {},
					fn: n.program(36, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 1086, column: 5 }, end: { line: 1086, column: 108 } },
				})) != null
					? i
					: '') +
				`
					document.querySelector('#submit-btn').disabled = true;
					document.querySelector('#submit-btn').style.cursor = 'not-allowed';
					document.querySelector('#submit-btn span').style.display = 'inline-block';

					let postUrl = '';
					if (!window.location.href.includes('form-waiting')) {
						postUrl = window.location.search;
					} else if (formSignature) {
						// For waiting forms, include signature in POST URL since it was cleaned from address bar
						postUrl = '?signature=' + encodeURIComponent(formSignature);
					}

					const authToken = '` +
				((i =
					((r = (r = f(o, 'authToken') || (t != null ? f(t, 'authToken') : t)) != null ? r : u),
					typeof r === c
						? r.call(s, {
								name: 'authToken',
								hash: {},
								data: a,
								loc: { start: { line: 1099, column: 24 }, end: { line: 1099, column: 41 } },
							})
						: r)) != null
					? i
					: '') +
				`';
					const headers = {};
					if(authToken) {
						headers['x-auth-token'] = authToken;
					}

					fetch(postUrl, {
						method: 'POST',
						body: formData,
						headers,
					})
						.then(async function (response) {
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'hasAuthenticatedSubmitter') : t, {
					name: 'if',
					hash: {},
					fn: n.program(37, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 1111, column: 7 }, end: { line: 1125, column: 14 } },
				})) != null
					? i
					: '') +
				`
							const useResponseData = document.getElementById("useResponseData").value;

							if (useResponseData === "true") {
								const text = await response.text();
								let json;

								try{
									json = JSON.parse(text);
								} catch (e) {}

								if(json?.formWaitingUrl) {
									formWaitingUrl = json.formWaitingUrl;
									// Extract signature from URL for subsequent requests
									const waitingUrl = new URL(json.formWaitingUrl);
									formSignature = waitingUrl.searchParams.get('signature');
									clearTimeout(timeoutId);
									timeoutId = setTimeout(checkExecutionStatus, interval);
									return;
								}

								if (json?.redirectURL) {
									// The author's end-of-form redirect leaves the form, so inside the
									// hosting shell it must take the whole tab, not the sandboxed frame.
									redirectTo(json.redirectURL);
									return;
								}

								if (json?.formSubmittedText) {
									form.style.display = 'none';
									document.querySelector('#submitted-form').style.display = 'block';
									document.querySelector('#submitted-content').textContent = json.formSubmittedText;
									return;
								}

								if (text) {
									document.body.innerHTML = text;
									return;
								}

								if (text === '') {
									// this is empty cleanup response from responsePromise
									// no need to keep checking execution status
									clearTimeout(timeoutId);
									interval = 0;
								}
							}

							if (response.status === 200) {
								if(response.redirected) {
									// Another page of this form moves the frame; anything else is a
									// redirect out of the form and takes the tab.
									if (isHostNavigable(response.url)) navigateTo(response.url);
									else redirectTo(response.url);
									return;
								}
								const redirectUrl = document.getElementById("redirectUrl");
								if (redirectUrl) {
									redirectTo(redirectUrl.href);
								} else {
									form.style.display = 'none';
									document.querySelector('#submitted-form').style.display = 'block';
								}
							} else {
								form.style.display = 'none';
								document.querySelector('#submitted-form').style.display = 'block';
								document.querySelector('#submitted-header').textContent = 'Problem submitting response';
								document.querySelector('#submitted-content').textContent =
									response.status === 413
										? 'The files you are trying to upload are too large. Please reduce the total size and try again.'
										: 'Please try again or contact support if the problem persists';
							}

							return;
						})
						.catch(function (error) {
							console.error('Error:', error);
							form.style.display = 'none';
							document.querySelector('#submitted-form').style.display = 'block';
							document.querySelector('#submitted-header').textContent = 'Problem submitting response';
							document.querySelector('#submitted-content').textContent =
								'The form could not be submitted. Please check your connection and try again, or contact support if the problem persists.';
						})
						.finally(() => {
							if (window.location.href.includes('form-waiting')) {
								clearTimeout(timeoutId);
								timeoutId = setTimeout(checkExecutionStatus, interval);
							}
						});
				}
			});
		</script>
` +
				((i = f(o, 'if').call(s, t != null ? f(t, 'shellInner') : t, {
					name: 'if',
					hash: {},
					fn: n.program(38, a, 0, e, l),
					inverse: n.noop,
					data: a,
					loc: { start: { line: 1218, column: 2 }, end: { line: 1243, column: 9 } },
				})) != null
					? i
					: '') +
				`	</body>
</html>
`
			);
		},
		usePartial: !0,
		useData: !0,
		useDepths: !0,
	}),
	'send-and-wait-no-action-required': b.default.template({
		compiler: [8, '>= 4.3.0'],
		main: function (n, t, o, d, a) {
			return `<html lang='en'>

	<head>
		<meta charset='UTF-8' />
		<meta name='viewport' content='width=device-width, initial-scale=1.0' />
		<link rel='icon' type='image/png' href='https://n8n.io/favicon.ico' />
		<link
			href='https://fonts.googleapis.com/css?family=Open+Sans'
			rel='stylesheet'
			type='text/css'
		/>
		<title>No action required</title>
		<style>
			*, ::after, ::before { box-sizing: border-box; margin: 0; padding: 0; } body { font-family:
			Open Sans, sans-serif; font-weight: 400; font-size: 12px; display: flex; flex-direction:
			column; justify-content: start; background-color: #FBFCFE; } .container { margin: auto;
			text-align: center; padding-top: 24px; width: 448px; } .card { padding: 24px;
			background-color: white; border: 1px solid #DBDFE7; border-radius: 8px; box-shadow: 0px 4px
			16px 0px #634DFF0F; margin-bottom: 16px; } .n8n-link a { color: #7E8186; font-weight: 600;
			font-size: 12px; text-decoration: none; } .n8n-link svg { display: inline-block;
			vertical-align: middle; } .header h1 { color: #525356; font-size: 20px; font-weight: 400;
			padding-bottom: 8px; } .header p { color: #7E8186; font-size: 14px; font-weight: 400; }
		</style>
	</head>

	<body>
		<div class='container'>
			<section>
				<div class='card'>
					<div class='header'>
						<h1>No action required</h1>
					</div>
				</div>
				<div class='n8n-link'>
					<a
						href='https://n8n.io/?utm_source=n8n-internal&amp;utm_medium=form-trigger&amp'
						target='_blank'
					>
						Form automated with
						<svg
							width='73'
							height='20'
							viewBox='0 0 73 20'
							fill='none'
							xmlns='http://www.w3.org/2000/svg'
						>
							<path
								fill-rule='evenodd'
								clip-rule='evenodd'
								d='M40.2373 4C40.2373 6.20915 38.4464 8 36.2373 8C34.3735 8 32.8074 6.72525 32.3633 5H26.7787C25.801 5 24.9666 5.70685 24.8059 6.6712L24.6415 7.6576C24.4854 8.59415 24.0116 9.40925 23.3417 10C24.0116 10.5907 24.4854 11.4058 24.6415 12.3424L24.8059 13.3288C24.9666 14.2931 25.801 15 26.7787 15H28.3633C28.8074 13.2747 30.3735 12 32.2373 12C34.4464 12 36.2373 13.7908 36.2373 16C36.2373 18.2092 34.4464 20 32.2373 20C30.3735 20 28.8074 18.7253 28.3633 17H26.7787C24.8233 17 23.1546 15.5864 22.8331 13.6576L22.6687 12.6712C22.508 11.7069 21.6736 11 20.6959 11H19.0645C18.5652 12.64 17.0406 13.8334 15.2373 13.8334C13.434 13.8334 11.9094 12.64 11.4101 11H9.06449C8.56519 12.64 7.04059 13.8334 5.2373 13.8334C3.02817 13.8334 1.2373 12.0424 1.2373 9.83335C1.2373 7.6242 3.02817 5.83335 5.2373 5.83335C7.16069 5.83335 8.76699 7.19085 9.15039 9H11.3242C11.7076 7.19085 13.3139 5.83335 15.2373 5.83335C17.1607 5.83335 18.767 7.19085 19.1504 9H20.6959C21.6736 9 22.508 8.29315 22.6687 7.3288L22.8331 6.3424C23.1546 4.41365 24.8233 3 26.7787 3H32.3633C32.8074 1.27478 34.3735 0 36.2373 0C38.4464 0 40.2373 1.79086 40.2373 4ZM38.2373 4C38.2373 5.10455 37.3419 6 36.2373 6C35.1327 6 34.2373 5.10455 34.2373 4C34.2373 2.89543 35.1327 2 36.2373 2C37.3419 2 38.2373 2.89543 38.2373 4ZM5.2373 11.8334C6.34189 11.8334 7.23729 10.9379 7.23729 9.83335C7.23729 8.72875 6.34189 7.83335 5.2373 7.83335C4.13273 7.83335 3.2373 8.72875 3.2373 9.83335C3.2373 10.9379 4.13273 11.8334 5.2373 11.8334ZM15.2373 11.8334C16.3419 11.8334 17.2373 10.9379 17.2373 9.83335C17.2373 8.72875 16.3419 7.83335 15.2373 7.83335C14.1327 7.83335 13.2373 8.72875 13.2373 9.83335C13.2373 10.9379 14.1327 11.8334 15.2373 11.8334ZM32.2373 18C33.3419 18 34.2373 17.1045 34.2373 16C34.2373 14.8954 33.3419 14 32.2373 14C31.1327 14 30.2373 14.8954 30.2373 16C30.2373 17.1045 31.1327 18 32.2373 18Z'
								fill='#EA4B71'
							></path>
							<path
								d='M44.2393 15.0007H46.3277V10.5791C46.3277 9.12704 47.2088 8.49074 48.204 8.49074C49.183 8.49074 49.9498 9.14334 49.9498 10.4812V15.0007H52.038V10.057C52.038 7.91969 50.798 6.67969 48.8567 6.67969C47.633 6.67969 46.9477 7.16914 46.4582 7.80544H46.3277L46.1482 6.84284H44.2393V15.0007Z'
								fill='#101330'
							></path>
							<path
								d='M60.0318 9.50205V9.40415C60.7498 9.0452 61.4678 8.4252 61.4678 7.20155C61.4678 5.43945 60.0153 4.37891 58.0088 4.37891C55.9528 4.37891 54.4843 5.5047 54.4843 7.23415C54.4843 8.4089 55.1698 9.0452 55.9203 9.40415V9.50205C55.0883 9.79575 54.0928 10.6768 54.0928 12.1452C54.0928 13.9237 55.5613 15.1637 57.9923 15.1637C60.4233 15.1637 61.8428 13.9237 61.8428 12.1452C61.8428 10.6768 60.8638 9.81205 60.0318 9.50205ZM57.9923 5.87995C58.8083 5.87995 59.4118 6.40205 59.4118 7.2831C59.4118 8.16415 58.7918 8.6863 57.9923 8.6863C57.1928 8.6863 56.5238 8.16415 56.5238 7.2831C56.5238 6.38575 57.1603 5.87995 57.9923 5.87995ZM57.9923 13.5974C57.0458 13.5974 56.2793 12.9937 56.2793 11.9658C56.2793 11.0358 56.9153 10.3342 57.9758 10.3342C59.0203 10.3342 59.6568 11.0195 59.6568 11.9984C59.6568 12.9937 58.9223 13.5974 57.9923 13.5974Z'
								fill='#101330'
							></path>
							<path
								d='M63.9639 15.0007H66.0524V10.5791C66.0524 9.12704 66.9334 8.49074 67.9289 8.49074C68.9079 8.49074 69.6744 9.14334 69.6744 10.4812V15.0007H71.7629V10.057C71.7629 7.91969 70.5229 6.67969 68.5814 6.67969C67.3579 6.67969 66.6724 7.16914 66.1829 7.80544H66.0524L65.8729 6.84284H63.9639V15.0007Z'
								fill='#101330'
							></path>
						</svg>

					</a>
				</div>
			</section>
		</div>
	</body>

</html>
`;
		},
		useData: !0,
	}),
};
function nr(n, t) {
	if (!sn[n]) throw new Error('Unknown form template: ' + n);
	return sn[n](t);
}
export { nr as renderTemplate };
