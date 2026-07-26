//! The decisive part of the spike: our own wgpu render pass, recorded into
//! egui's encoder, drawing a lit mesh with the selected texture on it.
//!
//! This is exactly what GPUI could not do on macOS — its mac backend is Metal
//! (`gpui_macos`), not the cross-platform `gpui_wgpu` path, so there was no way
//! to get at the buffer the toolkit was compositing into. `egui_wgpu` exposes it
//! through `CallbackTrait`, on every platform wgpu supports.
//!
//! Note on depth: there is no depth buffer here, because egui's render pass has
//! none. Back-face culling alone is sufficient for the shapes drawn — a sphere
//! is convex, and the plane is emitted twice with opposing winding so exactly
//! one of the two coincident triangles survives culling at any angle. A real
//! port would render to its own colour+depth target instead; that changes
//! nothing about the question being answered.

use bytemuck::{Pod, Zeroable};
use eframe::wgpu;
use glam::{Mat4, Vec3};

use crate::decode::Rgba;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Sphere,
    Plane,
}

#[derive(Clone, Copy)]
pub struct MaterialParams {
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    pub tiling: f32,
    pub roughness: f32,
    pub light_yaw: f32,
    pub shape: Shape,
    pub aspect: f32,
}

impl Default for MaterialParams {
    fn default() -> Self {
        Self {
            yaw: 0.6,
            pitch: 0.25,
            distance: 3.2,
            tiling: 1.0,
            roughness: 0.45,
            light_yaw: 0.9,
            shape: Shape::Sphere,
            aspect: 1.0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    view_proj: [[f32; 4]; 4],
    model: [[f32; 4]; 4],
    /// xyz = direction to the light, w = uv tiling factor.
    light: [f32; 4],
    /// xyz = camera position, w unused.
    camera: [f32; 4],
    /// x = roughness, y = 1.0 when the target is a non-sRGB format and the
    /// shader has to encode gamma itself, z/w unused.
    params: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
}

pub struct MaterialRenderer {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    uniform_buf: wgpu::Buffer,
    vertex_buf: wgpu::Buffer,
    index_buf: wgpu::Buffer,
    sphere: std::ops::Range<u32>,
    plane: std::ops::Range<u32>,
    sampler: wgpu::Sampler,
    bind_group: wgpu::BindGroup,
    /// Kept alive so the bind group's view stays valid; replaced on selection.
    _texture: wgpu::Texture,
    encode_gamma: bool,
}

impl MaterialRenderer {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, target: wgpu::TextureFormat) -> Self {
        let (vertices, indices, sphere, plane) = build_meshes();

        let vertex_buf = create_buffer(device, "spike.vertices", bytemuck::cast_slice(&vertices), wgpu::BufferUsages::VERTEX);
        let index_buf = create_buffer(device, "spike.indices", bytemuck::cast_slice(&indices), wgpu::BufferUsages::INDEX);

        let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("spike.uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("spike.bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("spike.sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });

        // Neutral grey stand-in so the viewport is lit and orbitable before any
        // file is selected — a blank panel would look like a broken GPU path,
        // which is the one thing this spike must not be ambiguous about.
        let texture = upload_texture(device, queue, &Rgba { width: 1, height: 1, pixels: vec![180, 180, 180, 255] });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("spike.shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("spike.pipeline_layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("spike.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: target,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let bind_group = make_bind_group(device, &layout, &uniform_buf, &texture, &sampler);

        Self {
            pipeline,
            layout,
            uniform_buf,
            vertex_buf,
            index_buf,
            sphere,
            plane,
            sampler,
            bind_group,
            _texture: texture,
            // Only *_Srgb targets get the hardware sRGB write. On a plain Unorm
            // surface the shader has to encode gamma itself or everything comes
            // out washed out — and the surface format differs between platforms,
            // so this cannot be assumed either way.
            encode_gamma: !target.is_srgb(),
        }
    }

    pub fn set_texture(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, rgba: &Rgba) {
        let texture = upload_texture(device, queue, rgba);
        self.bind_group = make_bind_group(device, &self.layout, &self.uniform_buf, &texture, &self.sampler);
        self._texture = texture;
    }

    pub fn update(&self, queue: &wgpu::Queue, p: &MaterialParams) {
        let eye = Vec3::new(
            p.distance * p.pitch.cos() * p.yaw.sin(),
            p.distance * p.pitch.sin(),
            p.distance * p.pitch.cos() * p.yaw.cos(),
        );
        let view = Mat4::look_at_rh(eye, Vec3::ZERO, Vec3::Y);
        let proj = Mat4::perspective_rh(45f32.to_radians(), p.aspect.max(0.01), 0.1, 100.0);
        let light = Vec3::new(p.light_yaw.sin(), 0.6, p.light_yaw.cos()).normalize();

        let u = Uniforms {
            view_proj: (proj * view).to_cols_array_2d(),
            model: Mat4::IDENTITY.to_cols_array_2d(),
            light: [light.x, light.y, light.z, p.tiling],
            camera: [eye.x, eye.y, eye.z, 0.0],
            params: [
                p.roughness.clamp(0.03, 1.0),
                if self.encode_gamma { 1.0 } else { 0.0 },
                0.0,
                0.0,
            ],
        };
        queue.write_buffer(&self.uniform_buf, 0, bytemuck::bytes_of(&u));
    }

    /// `viewport` is `[x, y, w, h]` in physical pixels. Split out from the egui
    /// callback so `headless.rs` can drive the identical draw with no window —
    /// which is what lets a macos-latest CI runner answer the mac question.
    pub fn draw(&self, rp: &mut wgpu::RenderPass<'static>, viewport: [f32; 4], shape: Shape) {
        rp.set_viewport(viewport[0], viewport[1], viewport[2], viewport[3], 0.0, 1.0);
        rp.set_pipeline(&self.pipeline);
        rp.set_bind_group(0, &self.bind_group, &[]);
        rp.set_vertex_buffer(0, self.vertex_buf.slice(..));
        rp.set_index_buffer(self.index_buf.slice(..), wgpu::IndexFormat::Uint32);
        let range = match shape {
            Shape::Sphere => self.sphere.clone(),
            Shape::Plane => self.plane.clone(),
        };
        rp.draw_indexed(range, 0, 0..1);
    }
}

fn create_buffer(device: &wgpu::Device, label: &str, contents: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents,
        usage,
    })
}

fn make_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    uniform: &wgpu::Buffer,
    texture: &wgpu::Texture,
    sampler: &wgpu::Sampler,
) -> wgpu::BindGroup {
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("spike.bind_group"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    })
}

fn upload_texture(device: &wgpu::Device, queue: &wgpu::Queue, rgba: &Rgba) -> wgpu::Texture {
    let size = wgpu::Extent3d {
        width: rgba.width.max(1),
        height: rgba.height.max(1),
        depth_or_array_layers: 1,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("spike.material_texture"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        // Srgb: the decoded bytes are sRGB-encoded, and the shader lights in
        // linear space. Letting the sampler do the conversion is both correct
        // and free.
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &rgba.pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(rgba.width.max(1) * 4),
            rows_per_image: Some(rgba.height.max(1)),
        },
        size,
    );
    texture
}

/// UV sphere plus a two-sided unit quad, in one vertex/index buffer.
fn build_meshes() -> (Vec<Vertex>, Vec<u32>, std::ops::Range<u32>, std::ops::Range<u32>) {
    const STACKS: u32 = 48;
    const SECTORS: u32 = 96;

    let mut vertices = Vec::new();
    let mut indices = Vec::new();

    for i in 0..=STACKS {
        let phi = std::f32::consts::PI * i as f32 / STACKS as f32;
        for j in 0..=SECTORS {
            let theta = std::f32::consts::TAU * j as f32 / SECTORS as f32;
            let n = Vec3::new(phi.sin() * theta.cos(), phi.cos(), phi.sin() * theta.sin());
            vertices.push(Vertex {
                position: n.to_array(),
                normal: n.to_array(),
                uv: [j as f32 / SECTORS as f32, i as f32 / STACKS as f32],
            });
        }
    }
    let row = SECTORS + 1;
    for i in 0..STACKS {
        for j in 0..SECTORS {
            let a = i * row + j;
            let b = a + row;
            indices.extend_from_slice(&[a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    let sphere = 0..indices.len() as u32;

    let plane_base = vertices.len() as u32;
    let plane_start = indices.len() as u32;
    for (x, y, u, v) in [
        (-1.0f32, -1.0f32, 0.0f32, 1.0f32),
        (1.0, -1.0, 1.0, 1.0),
        (1.0, 1.0, 1.0, 0.0),
        (-1.0, 1.0, 0.0, 0.0),
    ] {
        vertices.push(Vertex {
            position: [x, y, 0.0],
            normal: [0.0, 0.0, 1.0],
            uv: [u, v],
        });
    }
    // Back-facing copy: same positions, flipped normal and winding, so the quad
    // stays visible from behind despite back-face culling.
    for i in 0..4 {
        let mut v = vertices[(plane_base + i) as usize];
        v.normal = [0.0, 0.0, -1.0];
        vertices.push(v);
    }
    indices.extend_from_slice(&[
        plane_base,
        plane_base + 1,
        plane_base + 2,
        plane_base,
        plane_base + 2,
        plane_base + 3,
    ]);
    let back = plane_base + 4;
    indices.extend_from_slice(&[back, back + 2, back + 1, back, back + 3, back + 2]);
    let plane = plane_start..indices.len() as u32;

    (vertices, indices, sphere, plane)
}

const SHADER: &str = r#"
struct Uniforms {
    view_proj: mat4x4<f32>,
    model: mat4x4<f32>,
    light: vec4<f32>,
    camera: vec4<f32>,
    params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var base_tex: texture_2d<f32>;
@group(0) @binding(2) var base_sampler: sampler;

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
) -> VsOut {
    var out: VsOut;
    let world = u.model * vec4<f32>(position, 1.0);
    out.world = world.xyz;
    out.normal = (u.model * vec4<f32>(normal, 0.0)).xyz;
    out.uv = uv * u.light.w;
    out.clip = u.view_proj * world;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let base = textureSample(base_tex, base_sampler, in.uv);
    let n = normalize(in.normal);
    let l = normalize(u.light.xyz);
    let v = normalize(u.camera.xyz - in.world);
    let h = normalize(l + v);

    let ndl = max(dot(n, l), 0.0);
    let ndh = max(dot(n, h), 0.0);

    // Blinn-Phong standing in for GGX: enough to show normal detail and tiling,
    // which is all the spike needs. The shipping preview uses three.js PBR+IBL.
    let shininess = 2.0 / pow(max(u.params.x, 0.03), 4.0) - 2.0;
    let spec = pow(ndh, shininess) * (1.0 - u.params.x);

    // Cheap hemispheric ambient so the unlit side is readable rather than black.
    let ambient = mix(vec3<f32>(0.10, 0.11, 0.13), vec3<f32>(0.30, 0.32, 0.36), n.y * 0.5 + 0.5);

    var color = base.rgb * (ambient + vec3<f32>(ndl)) + vec3<f32>(spec * 0.4);

    if (u.params.y > 0.5) {
        color = pow(color, vec3<f32>(1.0 / 2.2));
    }
    return vec4<f32>(color, base.a);
}
"#;
