# Blender（bpy）建模 + Cycles 烘焙：火山 x3 與鍋貼，輸出 glTF
import bpy, bmesh, math, os, sys
OUT = sys.argv[-1]
os.makedirs(OUT, exist_ok=True)
TEX = 1024

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 1
    sc.render.bake.margin = 8
    return sc

# ---------- 與網頁相同的雜訊 ----------
def h3(x, y, z):
    s = math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
    return s - math.floor(s)
def vn(x, y, z):
    xi, yi, zi = math.floor(x), math.floor(y), math.floor(z); xf, yf, zf = x - xi, y - yi, z - zi
    u, v, w = xf*xf*(3-2*xf), yf*yf*(3-2*yf), zf*zf*(3-2*zf); L = lambda a, b, t: a + (b-a)*t
    return L(L(L(h3(xi,yi,zi),h3(xi+1,yi,zi),u),L(h3(xi,yi+1,zi),h3(xi+1,yi+1,zi),u),v),L(L(h3(xi,yi,zi+1),h3(xi+1,yi,zi+1),u),L(h3(xi,yi+1,zi+1),h3(xi+1,yi+1,zi+1),u),v),w)
def fb(x, y, z): return vn(x,y,z)*.55 + vn(x*2.1,y*2.1,z*2.1)*.3 + vn(x*4.3,y*4.3,z*4.3)*.15
def sstep(a, b, x):
    t = max(0., min(1., (x-a)/(b-a))); return t*t*(3-2*t)

def surf(d, ang, f):
    ca, sa = math.cos(ang), math.sin(ang); nx, nz = ca*1.8 + d['seed'], sa*1.8 + d['seed']*1.7
    if f <= 1:
        n = fb(nx, f*2.6, nz); rid = 1 - abs(fb(nx*1.5, f*3+3, nz*1.5)*2 - 1)
        rr = (d['cr'] + (d['R']-d['cr'])*math.pow(1-f, 1.45)) * (1 + (n-.5)*.35*(1-f*.6) + (rid-.5)*.22*(1-f))
        return ca*rr, d['H']*f + (n-.5)*.18*(1-f), sa*rr*.95, rr
    g = f - 1; n1 = fb(nx, 2.6, nz); rr = d['cr']*(1+(n1-.5)*.14)*(1-g*.58)
    return ca*rr, d['H'] - d['dep']*math.pow(g, .8) + (fb(nx*1.3, g*2+7, nz*1.3)-.5)*.06, sa*rr*.95, rr

def node(nt, kind, loc, **kw):
    n = nt.nodes.new(kind); n.location = loc
    for k, v in kw.items(): setattr(n, k, v)
    return n

def bake(obj, mat, kind, name, colorspace='sRGB', w=TEX, h=TEX, fmt='JPEG'):
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = colorspace
    nt = mat.node_tree; tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img
    for n in nt.nodes: n.select = False
    tn.select = True; nt.nodes.active = tn
    bpy.ops.object.select_all(action='DESELECT')            # 只烘焙這個物件，避免覆寫其他物件的貼圖
    bpy.context.view_layer.objects.active = obj; obj.select_set(True)
    if kind == 'DIFFUSE': bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'})
    elif kind == 'NORMAL': bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT')
    else: bpy.ops.object.bake(type=kind)
    nt.nodes.remove(tn)
    img.filepath_raw = os.path.join(OUT, name + ('.jpg' if fmt == 'JPEG' else '.png')); img.file_format = fmt
    img.save(); return img

def export_mat(name, base, nrm, emit=None, rough=.6, coat=0.):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; p = nt.nodes['Principled BSDF']
    t = node(nt, 'ShaderNodeTexImage', (-600, 300), image=base); nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
    tn = node(nt, 'ShaderNodeTexImage', (-600, -200), image=nrm); nrm.colorspace_settings.name = 'Non-Color'
    nm = node(nt, 'ShaderNodeNormalMap', (-300, -200)); nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    if emit is not None:
        te = node(nt, 'ShaderNodeTexImage', (-600, 0), image=emit); nt.links.new(te.outputs['Color'], p.inputs['Emission Color']); p.inputs['Emission Strength'].default_value = 1.0
    p.inputs['Roughness'].default_value = rough
    if coat: p.inputs['Coat Weight'].default_value = coat
    return m

def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_image_format='JPEG', export_jpeg_quality=75, export_image_quality=75, export_yup=True)

# =====================================================================
# 火山
# =====================================================================
def build_volcano(i, d, RS=128, HS=64, CS=14):
    d = dict(d); d['cr'] = d['R']*.26; d['dep'] = d['H']*.24
    fs = [min(j/HS, 1) for j in range(HS+1)] + [1 + k/CS for k in range(1, CS+1)]
    chans = [k*1.57 + .35 + (k % 2)*.4 + i for k in range(4)]
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new('UVMap')
    lava_l = bm.verts.layers.float.new('lava'); hot_l = bm.verts.layers.float.new('hot')
    grid = []
    for j, f in enumerate(fs):
        row = []
        for c in range(RS+1):
            ang = (c % RS)/RS*2*math.pi
            if c == RS: row.append(row[0]); continue
            x, y, z, rr = surf(d, ang, f)
            lava = 0.
            if .3 <= f <= .99:
                s = (.985 - f)/.68*16
                for k, a0 in enumerate(chans):
                    ac = a0 + math.sin(s*.9 + k*2)*.14
                    da = (ang - ac + math.pi) % (2*math.pi) - math.pi
                    lava = max(lava, sstep(.11, .025, abs(da)*rr) * sstep(.3, .4, f))
            if lava > 0:                                   # 岩漿溝槽
                k = 1 - lava*.045/max(rr, .1); x *= k; z *= k; y += lava*.01
            v = bm.verts.new((x, -z, y)); v[lava_l] = lava; v[hot_l] = sstep(.88, 1.0, f) * (1 if f <= 1 else 1) + (sstep(1.0, 1.5, f) if f > 1 else 0)
            row.append(v)
        grid.append(row)
    rows = len(grid)
    for j in range(rows-1):
        for c in range(RS):
            a, b, cc, e = grid[j][c], grid[j][c+1], grid[j+1][c], grid[j+1][c+1]
            # 縫合處重複的頂點：最後一欄使用第一欄
            try: face = bm.faces.new((a, b, e, cc))
            except ValueError: continue
            uvs = [(c/RS, j/(rows-1)), ((c+1)/RS, j/(rows-1)), ((c+1)/RS, (j+1)/(rows-1)), (c/RS, (j+1)/(rows-1))]
            for lp, uv in zip(face.loops, uvs): lp[uvl].uv = uv
    # 火山口底部封口
    ctr = bm.verts.new((0, 0, d['H'] - d['dep'])); ctr[hot_l] = 1.; ctr[lava_l] = 0
    last = grid[-1]
    for c in range(RS):
        try:
            face = bm.faces.new((last[c], last[c+1], ctr))
            for lp, uv in zip(face.loops, [(c/RS, 1), ((c+1)/RS, 1), ((c+.5)/RS, 1)]): lp[uvl].uv = uv
        except ValueError: pass
    bm.normal_update()
    me = bpy.data.meshes.new(f'V{i}'); bm.to_mesh(me); bm.free()
    # 頂點屬性 → 顏色屬性，供材質讀取
    for nm in ('lava', 'hot'):
        src = me.attributes[nm]; ca = me.color_attributes.new(nm + '_c', 'FLOAT_COLOR', 'POINT')
        for k, dv in enumerate(src.data): ca.data[k].color = (dv.value, dv.value, dv.value, 1)
    obj = bpy.data.objects.new(f'V{i}', me); bpy.context.collection.objects.link(obj)
    for p in me.polygons: p.use_smooth = True
    # 檢查法線朝外
    bpy.context.view_layer.objects.active = obj; obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode='OBJECT')

    # ---- 程序化材質（烘焙用）----
    m = bpy.data.materials.new(f'Vsrc{i}'); m.use_nodes = True; nt = m.node_tree; p = nt.nodes['Principled BSDF']
    tc = node(nt, 'ShaderNodeTexCoord', (-1600, 0))
    nz = node(nt, 'ShaderNodeTexNoise', (-1300, 300)); nz.inputs['Scale'].default_value = 2.2; nz.inputs['Detail'].default_value = 12; nz.inputs['Roughness'].default_value = .62
    nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
    rp = node(nt, 'ShaderNodeValToRGB', (-1050, 300)); el = rp.color_ramp.elements
    el[0].position, el[0].color = .3, (.03, .024, .022, 1); el[1].position, el[1].color = .72, (.16, .11, .09, 1)
    nt.links.new(nz.outputs['Fac'], rp.inputs['Fac'])
    # 灰白火山灰：朝上的面
    geo = node(nt, 'ShaderNodeNewGeometry', (-1300, -100)); sep = node(nt, 'ShaderNodeSeparateXYZ', (-1100, -100)); nt.links.new(geo.outputs['Normal'], sep.inputs['Vector'])
    ashr = node(nt, 'ShaderNodeMapRange', (-900, -100)); ashr.inputs['From Min'].default_value = .62; ashr.inputs['From Max'].default_value = .9; ashr.inputs['To Max'].default_value = .22
    nt.links.new(sep.outputs['Z'], ashr.inputs['Value'])
    mixa = node(nt, 'ShaderNodeMix', (-700, 200), data_type='RGBA'); mixa.inputs['B'].default_value = (.26, .23, .21, 1)
    nt.links.new(ashr.outputs['Result'], mixa.inputs['Factor']); nt.links.new(rp.outputs['Color'], mixa.inputs['A'])
    # 岩漿溝：冷卻黑殼
    la = node(nt, 'ShaderNodeVertexColor', (-1300, -400), layer_name='lava_c'); ho = node(nt, 'ShaderNodeVertexColor', (-1300, -650), layer_name='hot_c')
    mixl = node(nt, 'ShaderNodeMix', (-450, 200), data_type='RGBA'); mixl.inputs['B'].default_value = (.03, .015, .01, 1)
    nt.links.new(la.outputs['Color'], mixl.inputs['Factor']); nt.links.new(mixa.outputs['Result'], mixl.inputs['A'])
    nt.links.new(mixl.outputs['Result'], p.inputs['Base Color'])
    # 發光：岩漿流 + 火山口裂縫
    tn = node(nt, 'ShaderNodeTexNoise', (-1300, -900)); tn.inputs['Scale'].default_value = 9; tn.inputs['Detail'].default_value = 6; tn.inputs['Distortion'].default_value = 2.5
    nt.links.new(tc.outputs['Object'], tn.inputs['Vector'])
    vo = node(nt, 'ShaderNodeTexVoronoi', (-1300, -1150), feature='DISTANCE_TO_EDGE'); vo.inputs['Scale'].default_value = 5.5; nt.links.new(tc.outputs['Object'], vo.inputs['Vector'])
    cr = node(nt, 'ShaderNodeMapRange', (-1050, -1150)); cr.inputs['From Min'].default_value = .0; cr.inputs['From Max'].default_value = .05; cr.inputs['To Min'].default_value = 1; cr.inputs['To Max'].default_value = 0
    nt.links.new(vo.outputs['Distance'], cr.inputs['Value'])
    sepH = node(nt, 'ShaderNodeSeparateColor', (-1050, -650)); nt.links.new(ho.outputs['Color'], sepH.inputs['Color'])
    sepL = node(nt, 'ShaderNodeSeparateColor', (-1050, -400)); nt.links.new(la.outputs['Color'], sepL.inputs['Color'])
    crack = node(nt, 'ShaderNodeMath', (-800, -1000), operation='MULTIPLY'); nt.links.new(cr.outputs['Result'], crack.inputs[0]); nt.links.new(sepH.outputs['Red'], crack.inputs[1])
    lavam = node(nt, 'ShaderNodeMath', (-800, -800), operation='MULTIPLY'); nt.links.new(sepL.outputs['Red'], lavam.inputs[0]); lavam.inputs[1].default_value = 1.0
    tot = node(nt, 'ShaderNodeMath', (-600, -900), operation='MAXIMUM', use_clamp=True); nt.links.new(lavam.outputs[0], tot.inputs[0]); nt.links.new(crack.outputs[0], tot.inputs[1])
    var = node(nt, 'ShaderNodeMath', (-450, -900), operation='MULTIPLY'); nt.links.new(tot.outputs[0], var.inputs[0])
    tnr = node(nt, 'ShaderNodeMapRange', (-700, -1300)); tnr.inputs['To Min'].default_value = .45; nt.links.new(tn.outputs['Fac'], tnr.inputs['Value']); nt.links.new(tnr.outputs['Result'], var.inputs[1])
    er = node(nt, 'ShaderNodeValToRGB', (-250, -900)); el = er.color_ramp.elements
    el[0].position, el[0].color = .0, (0, 0, 0, 1); el[1].position, el[1].color = 1., (1, .85, .35, 1)
    e1 = el.new(.3); e1.color = (.45, .03, 0, 1); e2 = el.new(.62); e2.color = (1, .3, .02, 1)
    nt.links.new(var.outputs[0], er.inputs['Fac']); nt.links.new(er.outputs['Color'], p.inputs['Emission Color']); p.inputs['Emission Strength'].default_value = 1
    # 凹凸：岩石細節
    bn = node(nt, 'ShaderNodeTexNoise', (-900, -1500)); bn.inputs['Scale'].default_value = 14; bn.inputs['Detail'].default_value = 14; nt.links.new(tc.outputs['Object'], bn.inputs['Vector'])
    bu = node(nt, 'ShaderNodeBump', (-300, -1400)); bu.inputs['Strength'].default_value = .55; bu.inputs['Distance'].default_value = .06
    nt.links.new(bn.outputs['Fac'], bu.inputs['Height']); nt.links.new(bu.outputs['Normal'], p.inputs['Normal'])
    obj.data.materials.append(m)
    col = bake(obj, m, 'DIFFUSE', f'volcano{i}_color')
    emi = bake(obj, m, 'EMIT', f'volcano{i}_emit')
    nrm = bake(obj, m, 'NORMAL', f'volcano{i}_normal', colorspace='Non-Color', w=512, h=512)
    obj.data.materials.clear(); obj.data.materials.append(export_mat(f'volcano{i}', col, nrm, emi, rough=.88))
    # 只保留 UV，移除烘焙用屬性
    for nm in ('lava_c', 'hot_c'): me.color_attributes.remove(me.color_attributes[nm])
    for nm in ('lava', 'hot'): me.attributes.remove(me.attributes[nm])
    return obj

sc = reset()
defs = [dict(R=3.5, H=3.4, seed=1.3), dict(R=4.2, H=4.6, seed=4.1), dict(R=3.6, H=3.9, seed=7.7)]
vols = [build_volcano(i, d) for i, d in enumerate(defs)]
export(vols, os.path.join(OUT, 'volcanoes.glb'))
print('volcanoes done')

# =====================================================================
# 鍋貼
# =====================================================================
sc = reset()
bpy.ops.mesh.primitive_uv_sphere_add(segments=72, ring_count=40, radius=1)
g = bpy.context.active_object; g.name = 'Gyoza'
me = g.data
L, DEP, HT = .225, .128, .13
K = 1.9; R0 = 1/K
for v in me.vertices:
    x, y, z = v.co
    x *= L; tp = 1 - .4*(abs(x)/L)**4
    y *= DEP*tp
    if z > 0:
        t = z
        zz = z*HT*tp
        y *= 1 - .6*t**3                                 # 頂部捏合成摺邊
        zz += .016*t**4*tp
        ph = x/L*7.5*math.pi
        y += .012*math.sin(ph)*t**4*tp                   # 褶子波浪
        zz += .007*math.cos(ph*2)*t**6*tp
        y += .006*math.sin(ph)*t**2*tp                   # 褶子延伸到側面的皺摺
    else:
        zz = z*.022*tp                                    # 平底
    a = x*K                                               # 彎成新月
    X = (R0 - y)*math.sin(a); Y = R0 - (R0 - y)*math.cos(a)
    v.co = (X, Y, zz)
zmin = min(v.co.z for v in me.vertices)
for v in me.vertices: v.co.z += -.117 - zmin
for p in me.polygons: p.use_smooth = True
sub = g.modifiers.new('sub', 'SUBSURF'); sub.levels = 1; sub.render_levels = 1
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=.01); bpy.ops.object.mode_set(mode='OBJECT')
m = bpy.data.materials.new('Gsrc'); m.use_nodes = True; nt = m.node_tree; p = nt.nodes['Principled BSDF']
tc = node(nt, 'ShaderNodeTexCoord', (-1600, 0))
sepz = node(nt, 'ShaderNodeSeparateXYZ', (-1350, 200)); nt.links.new(tc.outputs['Object'], sepz.inputs['Vector'])
# 底部酥脆度：越低越焦，加雜訊邊界
nz = node(nt, 'ShaderNodeTexNoise', (-1350, -100)); nz.inputs['Scale'].default_value = 28; nz.inputs['Detail'].default_value = 8; nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
add = node(nt, 'ShaderNodeMath', (-1100, 150), operation='ADD'); nt.links.new(sepz.outputs['Z'], add.inputs[0])
nzs = node(nt, 'ShaderNodeMath', (-1150, -50), operation='MULTIPLY'); nt.links.new(nz.outputs['Fac'], nzs.inputs[0]); nzs.inputs[1].default_value = .035
nt.links.new(nzs.outputs[0], add.inputs[1])
cm = node(nt, 'ShaderNodeMapRange', (-900, 150)); cm.inputs['From Min'].default_value = -.07; cm.inputs['From Max'].default_value = -.118
nt.links.new(add.outputs[0], cm.inputs['Value'])
rp = node(nt, 'ShaderNodeValToRGB', (-650, 150)); el = rp.color_ramp.elements
el[0].position, el[0].color = 0, (.93, .84, .64, 1); el[1].position, el[1].color = 1, (.36, .15, .035, 1)
e = el.new(.35); e.color = (.9, .66, .3, 1); e2 = el.new(.7); e2.color = (.68, .36, .09, 1)
nt.links.new(cm.outputs['Result'], rp.inputs['Fac'])
# 麵皮細微斑點與油光
sp = node(nt, 'ShaderNodeTexVoronoi', (-900, -250)); sp.inputs['Scale'].default_value = 60; nt.links.new(tc.outputs['Object'], sp.inputs['Vector'])
spr = node(nt, 'ShaderNodeMapRange', (-700, -250)); spr.inputs['From Min'].default_value = .0; spr.inputs['From Max'].default_value = .25; spr.inputs['To Min'].default_value = .12; spr.inputs['To Max'].default_value = 0
nt.links.new(sp.outputs['Distance'], spr.inputs['Value'])
mx = node(nt, 'ShaderNodeMix', (-350, 100), data_type='RGBA'); mx.inputs['B'].default_value = (.7, .45, .16, 1)
nt.links.new(spr.outputs['Result'], mx.inputs['Factor']); nt.links.new(rp.outputs['Color'], mx.inputs['A']); nt.links.new(mx.outputs['Result'], p.inputs['Base Color'])
bn = node(nt, 'ShaderNodeTexNoise', (-700, -600)); bn.inputs['Scale'].default_value = 90; bn.inputs['Detail'].default_value = 6; nt.links.new(tc.outputs['Object'], bn.inputs['Vector'])
bu = node(nt, 'ShaderNodeBump', (-350, -500)); bu.inputs['Strength'].default_value = .35; bu.inputs['Distance'].default_value = .004
nt.links.new(bn.outputs['Fac'], bu.inputs['Height']); nt.links.new(bu.outputs['Normal'], p.inputs['Normal'])
g.data.materials.append(m)
col = bake(g, m, 'DIFFUSE', 'gyoza_color')
nrm = bake(g, m, 'NORMAL', 'gyoza_normal', colorspace='Non-Color')
g.data.materials.clear(); g.data.materials.append(export_mat('gyoza', col, nrm, rough=.42, coat=.45))
export([g], os.path.join(OUT, 'gyoza.glb'))
print('gyoza done')
