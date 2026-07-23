import type { ReactElement } from "react";
import { AudioLines } from "lucide-react";
import { useLibraryStore, type LibFile } from "../../stores/libraryStore";
import { useThumbSrc } from "../../hooks/useThumbSrc";
import { useRenderPrefs } from "../../stores/renderPrefs";
import { toggleFavoriteSmart, useFavoritesStore } from "../../stores/favoritesStore";
import { humanSize } from "../FileRow";
import { formatTime } from "../player/TimeDisplay";
import AssetCell, { type Badge } from "./AssetCell";

export interface AudioCellProps {
  file: LibFile;
  selected: boolean;
  /** See AssetCellProps.focused. */
  focused?: boolean;
}

/**
 * Grid cell for an audio file. Its thumbnail is embedded cover art if the file
 * has any, else a waveform the backend renders — both served over the same
 * `thumb://` path as textures but keyed `"a"` (see thumbs.rs `build_audio`), so
 * this uses the derived-key optimistic `<img>` path like TextureCell.
 */
export default function AudioCell({ file, selected, focused }: AudioCellProps): ReactElement {
  const { src, imgKey, onError, onLoad } = useThumbSrc(file, "a");
  const pixelArt = useRenderPrefs((s) => s.pixelArt);
  const starred = useFavoritesStore((s) => s.favorites.has(file.path));
  // Duration lands from the audio probe (durationsVersion ticks on each batch).
  useLibraryStore((s) => s.durationsVersion);
  const seconds = useLibraryStore.getState().durations.get(file.id);

  const badges: Badge[] = [{ text: file.ext.toUpperCase() }];

  return (
    <AssetCell
      name={file.name}
      sub={seconds !== undefined ? `${humanSize(file.size)} · ${formatTime(seconds)}` : humanSize(file.size)}
      badges={badges}
      selected={selected}
      focused={focused}
      starred={starred}
      onToggleStar={() => toggleFavoriteSmart(file.path)}
    >
      {src !== null ? (
        <img
          key={imgKey}
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          onError={onError}
          onLoad={onLoad}
          className="h-full w-full object-contain"
          style={{ imageRendering: pixelArt ? "pixelated" : "auto" }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <AudioLines size={22} className="text-kind-audio opacity-30" />
        </div>
      )}
    </AssetCell>
  );
}
